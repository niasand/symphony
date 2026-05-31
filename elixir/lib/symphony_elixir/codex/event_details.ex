defmodule SymphonyElixir.Codex.EventDetails do
  @moduledoc """
  Extracts operator-facing task detail fields from Codex app-server events.
  """

  @max_field_length 240

  @type detail_key :: :progress | :blocker | :plan
  @type details :: %{optional(detail_key()) => String.t()}

  @spec merge(details() | nil, map()) :: details()
  def merge(existing_details, update) when is_map(update) do
    existing_details
    |> normalize_details()
    |> apply_operations(detail_operations(update))
  end

  def merge(existing_details, _update), do: normalize_details(existing_details)

  defp normalize_details(details) when is_map(details) do
    details
    |> Enum.reduce(%{}, fn
      {key, value}, acc when key in [:progress, :blocker, :plan] and is_binary(value) ->
        case inline_text(value) do
          "" -> acc
          text -> Map.put(acc, key, text)
        end

      {key, value}, acc when key in ["progress", "blocker", "plan"] and is_binary(value) ->
        case inline_text(value) do
          "" -> acc
          text -> Map.put(acc, String.to_existing_atom(key), text)
        end

      _other, acc ->
        acc
    end)
  end

  defp normalize_details(_details), do: %{}

  defp apply_operations(details, operations) do
    Enum.reduce(operations, details, fn {field, mode, value}, acc ->
      put_detail(acc, field, mode, value)
    end)
  end

  defp put_detail(details, _field, _mode, value) when not is_binary(value), do: details

  defp put_detail(details, field, :replace, value) do
    case inline_text(value) do
      "" -> details
      text -> Map.put(details, field, text)
    end
  end

  defp put_detail(details, field, :append, value) do
    case inline_text(value) do
      "" ->
        details

      text ->
        existing = Map.get(details, field, "")
        Map.put(details, field, inline_text(existing <> text))
    end
  end

  defp detail_operations(update) do
    payload = update_payload(update)
    event = map_value(update, [:event, "event"])
    method = method_name(payload)

    [
      progress_operation(method, payload),
      blocker_operation(event, method, payload),
      plan_operation(method, payload)
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp update_payload(update) do
    update
    |> map_value([:payload, "payload", :message, "message"])
    |> unwrap_payload()
  end

  defp unwrap_payload(%{} = payload) do
    cond do
      is_binary(map_value(payload, ["method", :method])) -> payload
      true -> (map_value(payload, ["payload", :payload]) || payload) |> unwrap_nested_payload()
    end
  end

  defp unwrap_payload(payload), do: payload

  defp unwrap_nested_payload(%{} = payload) do
    if is_binary(map_value(payload, ["method", :method])) do
      payload
    else
      payload
    end
  end

  defp unwrap_nested_payload(payload), do: payload

  defp method_name(%{} = payload), do: map_value(payload, ["method", :method])
  defp method_name(_payload), do: nil

  defp progress_operation(method, payload) when is_binary(method) do
    cond do
      agent_message_method?(method) ->
        text_operation(:progress, :append, extract_delta_preview(payload))

      reasoning_method?(method) ->
        text_operation(:progress, :append, extract_reasoning_focus(payload) || extract_delta_preview(payload))

      method == "codex/event/exec_command_begin" ->
        text_operation(:progress, :replace, prefixed_text("running command: ", extract_wrapper_command(payload)))

      method == "codex/event/exec_command_end" ->
        text_operation(:progress, :replace, exec_command_end_text(payload))

      method == "turn/started" || method == "turn/start" ->
        {:progress, :replace, "turn started"}

      method == "turn/completed" ->
        {:progress, :replace, "turn completed"}

      true ->
        nil
    end
  end

  defp progress_operation(_method, _payload), do: nil

  defp blocker_operation(event, method, payload)
       when event in [:approval_auto_approved, :tool_input_auto_answered] do
    _ = method
    _ = payload
    nil
  end

  defp blocker_operation(event, method, payload) do
    cond do
      approval_event?(event, method) ->
        text_operation(:blocker, :replace, approval_text(method, payload))

      input_required_event?(event, method, payload) ->
        text_operation(:blocker, :replace, input_required_text(payload))

      true ->
        nil
    end
  end

  defp plan_operation("turn/plan/updated", payload),
    do: text_operation(:plan, :replace, format_plan(payload))

  defp plan_operation("item/plan/delta", payload),
    do: text_operation(:plan, :append, extract_delta_preview(payload))

  defp plan_operation("codex/event/plan_delta", payload),
    do: text_operation(:plan, :append, extract_delta_preview(payload))

  defp plan_operation(_method, _payload), do: nil

  defp text_operation(_field, _mode, nil), do: nil
  defp text_operation(field, mode, text) when is_binary(text), do: {field, mode, text}

  defp agent_message_method?(method) do
    method in [
      "item/agentMessage/delta",
      "codex/event/agent_message_delta",
      "codex/event/agent_message_content_delta"
    ]
  end

  defp reasoning_method?(method) do
    method in [
      "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded",
      "item/reasoning/textDelta",
      "codex/event/agent_reasoning",
      "codex/event/agent_reasoning_delta",
      "codex/event/reasoning_content_delta"
    ]
  end

  defp approval_event?(event, method) do
    event == :approval_required ||
      method in [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "execCommandApproval",
        "applyPatchApproval",
        "turn/approval_required"
      ]
  end

  defp input_required_event?(event, method, payload) do
    event == :turn_input_required ||
      method in [
        "turn/input_required",
        "turn/needs_input",
        "turn/need_input",
        "turn/request_input",
        "turn/request_response",
        "turn/provide_input",
        "item/tool/requestUserInput",
        "mcpServer/elicitation/request"
      ] ||
      requires_input?(payload)
  end

  defp requires_input?(payload) when is_map(payload) do
    params = map_value(payload, ["params", :params])

    Enum.any?([payload, params], fn value ->
      is_map(value) and
        (map_value(value, ["requiresInput", :requiresInput]) == true ||
           map_value(value, ["needsInput", :needsInput]) == true ||
           map_value(value, ["input_required", :input_required]) == true ||
           map_value(value, ["inputRequired", :inputRequired]) == true ||
           map_value(value, ["type", :type]) in ["input_required", "needs_input"])
    end)
  end

  defp requires_input?(_payload), do: false

  defp approval_text(method, payload) do
    cond do
      method in ["item/commandExecution/requestApproval", "execCommandApproval"] ->
        prefixed_text("approval required: ", extract_command(payload)) || "approval required"

      method in ["item/fileChange/requestApproval", "applyPatchApproval"] ->
        file_count = map_path(payload, ["params", "fileChangeCount"]) || map_path(payload, [:params, :fileChangeCount])

        if is_integer(file_count) do
          "approval required: #{file_count} file changes"
        else
          "approval required: file changes"
        end

      true ->
        "approval required"
    end
  end

  defp input_required_text(payload) do
    question =
      map_path(payload, ["params", "question"]) ||
        map_path(payload, [:params, :question]) ||
        first_question(payload) ||
        map_path(payload, ["params", "reason"]) ||
        map_path(payload, [:params, :reason])

    prefixed_text("operator input required: ", question) || "operator input required"
  end

  defp first_question(payload) do
    questions =
      map_path(payload, ["params", "questions"]) ||
        map_path(payload, [:params, :questions])

    case questions do
      [%{} = question | _] ->
        map_value(question, ["question", :question])

      _ ->
        nil
    end
  end

  defp format_plan(payload) do
    plan_entries =
      map_path(payload, ["params", "plan"]) ||
        map_path(payload, [:params, :plan]) ||
        map_path(payload, ["params", "steps"]) ||
        map_path(payload, [:params, :steps]) ||
        map_path(payload, ["params", "items"]) ||
        map_path(payload, [:params, :items])

    case plan_entries do
      entries when is_list(entries) ->
        entries
        |> Enum.map(&format_plan_entry/1)
        |> Enum.reject(&is_nil/1)
        |> Enum.take(4)
        |> Enum.join(" | ")
        |> blank_to_nil()

      _ ->
        nil
    end
  end

  defp format_plan_entry(%{} = entry) do
    step =
      map_value(entry, [
        "step",
        :step,
        "text",
        :text,
        "content",
        :content,
        "description",
        :description,
        "title",
        :title
      ])

    status = map_value(entry, ["status", :status])

    cond do
      is_binary(step) and is_binary(status) -> "#{status}: #{step}"
      is_binary(step) -> step
      true -> nil
    end
  end

  defp format_plan_entry(entry) when is_binary(entry), do: entry
  defp format_plan_entry(_entry), do: nil

  defp exec_command_end_text(payload) do
    exit_code =
      map_path(payload, ["params", "msg", "exit_code"]) ||
        map_path(payload, [:params, :msg, :exit_code]) ||
        map_path(payload, ["params", "msg", "exitCode"]) ||
        map_path(payload, [:params, :msg, :exitCode])

    if is_integer(exit_code) do
      "command completed: exit #{exit_code}"
    else
      "command completed"
    end
  end

  defp extract_wrapper_command(payload) do
    map_path(payload, ["params", "msg", "command"]) ||
      map_path(payload, [:params, :msg, :command]) ||
      map_path(payload, ["params", "msg", "parsed_cmd"]) ||
      map_path(payload, [:params, :msg, :parsed_cmd])
  end

  defp extract_command(payload) do
    payload
    |> map_path(["params", "parsedCmd"])
    |> fallback_command(payload)
    |> normalize_command()
  end

  defp fallback_command(nil, payload) do
    map_path(payload, ["params", "command"]) ||
      map_path(payload, ["params", "cmd"]) ||
      map_path(payload, ["params", "argv"]) ||
      map_path(payload, ["params", "args"])
  end

  defp fallback_command(command, _payload), do: command

  defp normalize_command(%{} = command) do
    binary_command = map_value(command, ["parsedCmd", :parsedCmd, "command", :command, "cmd", :cmd])
    args = map_value(command, ["args", :args, "argv", :argv])

    if is_binary(binary_command) and is_list(args) do
      normalize_command([binary_command | args])
    else
      normalize_command(binary_command || args)
    end
  end

  defp normalize_command(command) when is_binary(command), do: inline_text(command)

  defp normalize_command(command) when is_list(command) do
    if Enum.all?(command, &is_binary/1) do
      command
      |> Enum.join(" ")
      |> inline_text()
    end
  end

  defp normalize_command(_command), do: nil

  defp extract_delta_preview(payload) do
    payload
    |> extract_first_path(delta_paths())
    |> blank_to_nil()
  end

  defp extract_reasoning_focus(payload) do
    payload
    |> extract_first_path(reasoning_focus_paths())
    |> blank_to_nil()
  end

  defp delta_paths do
    [
      ["params", "delta"],
      [:params, :delta],
      ["params", "msg", "delta"],
      [:params, :msg, :delta],
      ["params", "textDelta"],
      [:params, :textDelta],
      ["params", "msg", "textDelta"],
      [:params, :msg, :textDelta],
      ["params", "text"],
      [:params, :text],
      ["params", "msg", "text"],
      [:params, :msg, :text],
      ["params", "summaryText"],
      [:params, :summaryText],
      ["params", "msg", "summaryText"],
      [:params, :msg, :summaryText],
      ["params", "msg", "content"],
      [:params, :msg, :content],
      ["params", "msg", "payload", "delta"],
      [:params, :msg, :payload, :delta],
      ["params", "msg", "payload", "textDelta"],
      [:params, :msg, :payload, :textDelta],
      ["params", "msg", "payload", "text"],
      [:params, :msg, :payload, :text],
      ["params", "msg", "payload", "summaryText"],
      [:params, :msg, :payload, :summaryText],
      ["params", "msg", "payload", "content"],
      [:params, :msg, :payload, :content]
    ]
  end

  defp reasoning_focus_paths do
    [
      ["params", "reason"],
      [:params, :reason],
      ["params", "summaryText"],
      [:params, :summaryText],
      ["params", "summary"],
      [:params, :summary],
      ["params", "text"],
      [:params, :text],
      ["params", "msg", "reason"],
      [:params, :msg, :reason],
      ["params", "msg", "summaryText"],
      [:params, :msg, :summaryText],
      ["params", "msg", "summary"],
      [:params, :msg, :summary],
      ["params", "msg", "text"],
      [:params, :msg, :text],
      ["params", "msg", "payload", "reason"],
      [:params, :msg, :payload, :reason],
      ["params", "msg", "payload", "summaryText"],
      [:params, :msg, :payload, :summaryText],
      ["params", "msg", "payload", "summary"],
      [:params, :msg, :payload, :summary],
      ["params", "msg", "payload", "text"],
      [:params, :msg, :payload, :text]
    ]
  end

  defp prefixed_text(prefix, value) when is_binary(value) do
    case inline_text(value) do
      "" -> nil
      text -> prefix <> text
    end
  end

  defp prefixed_text(_prefix, _value), do: nil

  defp blank_to_nil(value) when is_binary(value) do
    case inline_text(value) do
      "" -> nil
      text -> text
    end
  end

  defp blank_to_nil(_value), do: nil

  defp inline_text(text) when is_binary(text) do
    text
    |> String.replace("\n", " ")
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
    |> trim_to_max()
  end

  defp trim_to_max(text) do
    length = String.length(text)

    if length > @max_field_length do
      "..." <> String.slice(text, length - @max_field_length + 3, @max_field_length - 3)
    else
      text
    end
  end

  defp extract_first_path(payload, paths) do
    Enum.find_value(paths, fn path -> map_path(payload, path) end)
  end

  defp map_path(data, [key | rest]) when is_map(data) do
    case fetch_map_key(data, key) do
      {:ok, value} when rest == [] -> value
      {:ok, value} -> map_path(value, rest)
      :error -> nil
    end
  end

  defp map_path(data, []) when is_map(data), do: data
  defp map_path(_data, _path), do: nil

  defp map_value(data, keys) when is_map(data) and is_list(keys) do
    Enum.find_value(keys, fn key ->
      case fetch_map_key(data, key) do
        {:ok, value} -> value
        :error -> nil
      end
    end)
  end

  defp map_value(_data, _keys), do: nil

  defp fetch_map_key(map, key) do
    cond do
      Map.has_key?(map, key) ->
        {:ok, Map.get(map, key)}

      is_atom(key) and Map.has_key?(map, Atom.to_string(key)) ->
        {:ok, Map.get(map, Atom.to_string(key))}

      is_binary(key) ->
        atom_key = safe_existing_atom(key)

        if not is_nil(atom_key) and Map.has_key?(map, atom_key) do
          {:ok, Map.get(map, atom_key)}
        else
          :error
        end

      true ->
        :error
    end
  end

  defp safe_existing_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> nil
  end
end
