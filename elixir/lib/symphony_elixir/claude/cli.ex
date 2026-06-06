defmodule SymphonyElixir.Claude.CLI do
  @moduledoc """
  Runs Claude Code in non-interactive print mode for a Symphony issue turn.
  """

  require Logger

  alias SymphonyElixir.{Config, PathSafety, SSH}

  @port_line_bytes 1_048_576
  @max_pending_bytes 10 * 1024 * 1024
  @max_stream_log_bytes 1_000

  @type session :: %{
          conversation_id: String.t() | nil,
          workspace: Path.t(),
          worker_host: String.t() | nil
        }

  @spec run(Path.t(), String.t(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def run(workspace, prompt, issue, opts \\ []) do
    with {:ok, session} <- start_session(workspace, opts) do
      try do
        run_turn(session, prompt, issue, opts)
      after
        stop_session(session)
      end
    end
  end

  @spec start_session(Path.t(), keyword()) :: {:ok, session()} | {:error, term()}
  def start_session(workspace, opts \\ []) do
    worker_host = Keyword.get(opts, :worker_host)

    with {:ok, expanded_workspace} <- validate_workspace_cwd(workspace, worker_host),
         :ok <- validate_command(worker_host) do
      {:ok, %{conversation_id: nil, workspace: expanded_workspace, worker_host: worker_host}}
    end
  end

  @spec run_turn(session(), String.t(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def run_turn(%{workspace: workspace, worker_host: worker_host} = session, prompt, _issue, opts \\ []) do
    on_message = Keyword.get(opts, :on_message, &default_on_message/1)
    synthetic_session_id = session.conversation_id || "claude-#{System.unique_integer([:positive])}"

    emit_message(on_message, :session_started, %{
      session_id: synthetic_session_id,
      thread_id: session.conversation_id,
      turn_id: nil
    })

    with {:ok, port} <- start_turn_port(workspace, worker_host, session, prompt) do
      try do
        case await_turn_completion(port, session, on_message) do
          {:ok, result} ->
            conversation_id = result[:conversation_id] || session.conversation_id

            {:ok,
             %{
               result: result[:result],
               session_id: conversation_id || synthetic_session_id,
               thread_id: conversation_id,
               turn_id: nil,
               agent_session: %{session | conversation_id: conversation_id}
             }}

          {:error, reason} ->
            {:error, reason}
        end
      after
        stop_port(port)
      end
    end
  end

  @spec stop_session(session()) :: :ok
  def stop_session(_session), do: :ok

  defp start_turn_port(workspace, nil, session, prompt) do
    with {:ok, executable} <- resolve_local_command(Config.settings!().claude.command) do
      port =
        Port.open(
          {:spawn_executable, String.to_charlist(executable)},
          [
            :binary,
            :exit_status,
            :stderr_to_stdout,
            args: Enum.map(build_args(prompt, session), &String.to_charlist/1),
            cd: String.to_charlist(workspace)
          ]
        )

      {:ok, port}
    end
  rescue
    error in ErlangError ->
      {:error, {:claude_port_open_failed, error.original}}
  end

  defp start_turn_port(workspace, worker_host, session, prompt) when is_binary(worker_host) do
    command =
      [
        "cd #{shell_escape(workspace)}",
        "exec #{remote_invocation(prompt, session)}"
      ]
      |> Enum.join(" && ")

    SSH.start_port(worker_host, command, line: @port_line_bytes)
  end

  defp build_args(prompt, session) do
    claude = Config.settings!().claude

    ["-p", prompt, "--output-format", "stream-json", "--verbose"]
    |> maybe_add_resume(session.conversation_id)
    |> maybe_add_flag(claude.skip_permissions, "--dangerously-skip-permissions")
    |> maybe_add_option("--model", claude.model)
    |> maybe_add_positive_integer_option("--max-turns", claude.max_turns_per_invocation)
    |> maybe_add_option("--system-prompt", claude.system_prompt)
  end

  defp maybe_add_resume(args, conversation_id) when is_binary(conversation_id) and conversation_id != "",
    do: args ++ ["--resume", conversation_id]

  defp maybe_add_resume(args, _conversation_id), do: args

  defp maybe_add_flag(args, true, flag), do: args ++ [flag]
  defp maybe_add_flag(args, _enabled, _flag), do: args

  defp maybe_add_option(args, _flag, nil), do: args
  defp maybe_add_option(args, _flag, ""), do: args
  defp maybe_add_option(args, flag, value) when is_binary(value), do: args ++ [flag, value]

  defp maybe_add_positive_integer_option(args, flag, value) when is_integer(value) and value > 0,
    do: args ++ [flag, Integer.to_string(value)]

  defp maybe_add_positive_integer_option(args, _flag, _value), do: args

  @last_lines_max 5
  @last_line_bytes 500

  defp await_turn_completion(port, session, on_message) do
    receive_loop(port, session, on_message, Config.settings!().claude.turn_timeout_ms, "", 0, [])
  end

  defp receive_loop(port, session, on_message, timeout_ms, pending, pending_bytes, last_lines) do
    # Try to extract a complete line from the pending buffer first
    case extract_line(pending) do
      {line, rest} ->
        trimmed = String.slice(line, 0, @last_line_bytes)
        updated_last = keep_last(last_lines, trimmed)
        handle_stream_line(port, session, on_message, timeout_ms, line, updated_last, rest, byte_size(rest))

      :incomplete ->
        receive do
          {^port, {:data, chunk}} when is_binary(chunk) ->
            new_pending = pending <> chunk
            new_bytes = byte_size(new_pending)

            if new_bytes > @max_pending_bytes do
              {:error, {:turn_failed, :claude_output_exceeded_buffer_limit}}
            else
              receive_loop(port, session, on_message, timeout_ms, new_pending, new_bytes, last_lines)
            end

      {^port, {:exit_status, 0}} ->
        emit_message(on_message, :turn_completed, %{payload: %{exit_code: 0}})
        {:ok, %{result: :process_exited_clean, conversation_id: session.conversation_id}}

      {^port, {:exit_status, status}} ->
        Logger.warning("Claude CLI port_exit=#{status} last_output=#{inspect(last_lines)}")
        {:error, {:turn_failed, {:port_exit, status, last_lines}}}
    after
      timeout_ms ->
        {:error, :turn_timeout}
    end
  end

  # Extract the first complete line from a buffer. Returns {line, rest} or :incomplete.
  defp extract_line(buffer) do
    case :binary.match(buffer, "\n") do
      {pos, _len} ->
        line = binary_part(buffer, 0, pos)
        rest = binary_part(buffer, pos + 1, byte_size(buffer) - pos - 1)
        {line, rest}

      :nomatch ->
        :incomplete
    end
  end

  defp handle_stream_line(port, session, on_message, timeout_ms, line, last_lines, rest, rest_bytes) do
    line = to_string(line)

    case Jason.decode(line) do
      {:ok, %{"type" => "result"} = payload} ->
        handle_result_event(on_message, payload, session)

      {:ok, %{"type" => "assistant"} = payload} ->
        emit_message(on_message, :notification, %{
          payload: payload,
          raw: line,
          message: extract_text_content(payload)
        })

        receive_loop(port, session, on_message, timeout_ms, rest, rest_bytes, last_lines)

      {:ok, %{"type" => type} = payload} when type in ["tool_use", "tool_result"] ->
        emit_message(on_message, :notification, %{
          payload: payload,
          raw: line,
          message: "#{type}: #{Map.get(payload, "subtype", "")}"
        })

        receive_loop(port, session, on_message, timeout_ms, rest, rest_bytes, last_lines)

      {:ok, payload} ->
        emit_message(on_message, :notification, %{payload: payload, raw: line})
        receive_loop(port, session, on_message, timeout_ms, rest, rest_bytes, last_lines)

      {:error, _reason} ->
        log_non_json_stream_line(line)

        if protocol_message_candidate?(line) do
          emit_message(on_message, :malformed, %{payload: line, raw: line})
        end

        receive_loop(port, session, on_message, timeout_ms, rest, rest_bytes, last_lines)
    end
  end

  defp handle_result_event(on_message, payload, session) do
    conversation_id = Map.get(payload, "session_id") || session.conversation_id
    usage = usage_from_result(payload)
    subtype = Map.get(payload, "subtype")

    if subtype == "error_max_turns" do
      Logger.info("Claude turn reached max turns tokens=#{usage.total_tokens} cost=#{usage.cost_usd}")
    end

    if result_error?(payload) do
      emit_message(on_message, :turn_failed, %{payload: payload, usage: usage})
      {:error, {:turn_failed, Map.get(payload, "result", "unknown")}}
    else
      emit_message(on_message, :turn_completed, %{payload: payload, usage: usage})
      {:ok, %{result: Map.get(payload, "result", :turn_completed), conversation_id: conversation_id}}
    end
  end

  defp result_error?(payload) do
    case Map.get(payload, "subtype") do
      # error_max_turns: the turn was truncated, not failed.
      # The agent runner's turn loop may continue with more invocations.
      # Token data is still extracted via usage_from_result and emitted
      # before this function is called.
      "error_max_turns" ->
        false

      # Genuine errors — the turn actually failed.
      subtype when subtype in ["error", "error_tool_use"] ->
        Map.get(payload, "is_error") == true

      # Unknown subtypes: treat as error only when is_error is explicitly true.
      _ ->
        Map.get(payload, "is_error") == true
    end
  end

  defp usage_from_result(payload) when is_map(payload) do
    cost_usd = Map.get(payload, "cost_usd") || Map.get(payload, "total_cost_usd")

    # Token counts live in the final "result" event's "usage" field.
    # Intermediate assistant/user events always report 0 — ignore them.
    usage = Map.get(payload, "usage", %{})
    input_tokens = Map.get(usage, "input_tokens", 0)
    output_tokens = Map.get(usage, "output_tokens", 0)
    total_tokens = input_tokens + output_tokens

    # Also check modelUsage for per-model breakdown if available
    {input_tokens, output_tokens, total_tokens} =
      case Map.get(payload, "modelUsage") do
        model_usage when is_map(model_usage) ->
          # Sum across all models
          model_usage
          |> Map.values()
          |> Enum.reduce({0, 0, 0}, fn mu, {i, o, _t} ->
            mi = Map.get(mu, "inputTokens", 0) + i
            mo = Map.get(mu, "outputTokens", 0) + o
            {mi, mo, mi + mo}
          end)

        _ ->
          {input_tokens, output_tokens, total_tokens}
      end

    %{
      input_tokens: input_tokens,
      output_tokens: output_tokens,
      total_tokens: total_tokens,
      cost_usd: cost_usd,
      duration_ms: Map.get(payload, "duration_ms")
    }
  end

  defp extract_text_content(%{"content" => content}), do: text_from_content(content)
  defp extract_text_content(%{"message" => %{"content" => content}}), do: text_from_content(content)
  defp extract_text_content(_payload), do: nil

  defp text_from_content(content) when is_list(content) do
    content
    |> Enum.flat_map(fn
      %{"type" => "text", "text" => text} when is_binary(text) -> [text]
      _ -> []
    end)
    |> Enum.join("\n")
  end

  defp text_from_content(_content), do: nil

  defp validate_command(nil) do
    case resolve_local_command(Config.settings!().claude.command) do
      {:ok, _executable} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp validate_command(worker_host) when is_binary(worker_host), do: :ok

  defp resolve_local_command(command) when is_binary(command) do
    command = command |> String.trim() |> expand_tilde()

    cond do
      command == "" ->
        {:error, :claude_command_blank}

      String.contains?(command, "/") ->
        resolve_path_command(command)

      true ->
        case System.find_executable(command) do
          nil -> {:error, {:claude_not_found, command}}
          executable -> {:ok, executable}
        end
    end
  end

  defp resolve_local_command(_command), do: {:error, :claude_command_blank}

  defp resolve_path_command(command) do
    expanded = Path.expand(command)

    if File.exists?(expanded) do
      {:ok, expanded}
    else
      {:error, {:claude_not_found, command}}
    end
  end

  defp validate_workspace_cwd(workspace, nil) when is_binary(workspace) do
    expanded_workspace = Path.expand(workspace)
    expanded_root = Path.expand(Config.settings!().workspace.root)
    expanded_root_prefix = expanded_root <> "/"

    with {:ok, canonical_workspace} <- PathSafety.canonicalize(expanded_workspace),
         {:ok, canonical_root} <- PathSafety.canonicalize(expanded_root) do
      canonical_root_prefix = canonical_root <> "/"

      cond do
        canonical_workspace == canonical_root ->
          {:error, {:invalid_workspace_cwd, :workspace_root, canonical_workspace}}

        String.starts_with?(canonical_workspace <> "/", canonical_root_prefix) ->
          {:ok, canonical_workspace}

        String.starts_with?(expanded_workspace <> "/", expanded_root_prefix) ->
          {:error, {:invalid_workspace_cwd, :symlink_escape, expanded_workspace, canonical_root}}

        true ->
          {:error, {:invalid_workspace_cwd, :outside_workspace_root, canonical_workspace, canonical_root}}
      end
    else
      {:error, {:path_canonicalize_failed, path, reason}} ->
        {:error, {:invalid_workspace_cwd, :path_unreadable, path, reason}}
    end
  end

  defp validate_workspace_cwd(workspace, worker_host)
       when is_binary(workspace) and is_binary(worker_host) do
    cond do
      String.trim(workspace) == "" ->
        {:error, {:invalid_workspace_cwd, :empty_remote_workspace, worker_host}}

      String.contains?(workspace, ["\n", "\r", <<0>>]) ->
        {:error, {:invalid_workspace_cwd, :invalid_remote_workspace, worker_host, workspace}}

      true ->
        {:ok, workspace}
    end
  end

  defp remote_invocation(prompt, session) do
    [Config.settings!().claude.command | build_args(prompt, session)]
    |> Enum.map_join(" ", &shell_escape/1)
  end

  defp emit_message(on_message, event, details) when is_function(on_message, 1) do
    message = details |> Map.put(:event, event) |> Map.put(:timestamp, DateTime.utc_now())
    on_message.(message)
  end

  defp log_non_json_stream_line(data) do
    text =
      data
      |> to_string()
      |> String.trim()
      |> String.slice(0, @max_stream_log_bytes)

    if text != "" do
      if String.match?(text, ~r/\b(error|warn|warning|failed|fatal|panic|exception)\b/i) do
        Logger.warning("Claude stream output: #{text}")
      else
        Logger.debug("Claude stream output: #{text}")
      end
    end
  end

  defp protocol_message_candidate?(data) do
    data
    |> to_string()
    |> String.trim_leading()
    |> String.starts_with?("{")
  end

  defp stop_port(port) when is_port(port) do
    case :erlang.port_info(port) do
      :undefined ->
        :ok

      _ ->
        try do
          Port.close(port)
          :ok
        rescue
          ArgumentError ->
            :ok
        end
    end
  end

  defp expand_tilde("~/" <> path), do: Path.join(System.user_home!(), path)
  defp expand_tilde(path), do: path

  defp shell_escape(value) when is_binary(value) do
    "'" <> String.replace(value, "'", "'\"'\"'") <> "'"
  end

  defp default_on_message(_message), do: :ok

  defp keep_last(lines, new_line) when length(lines) >= @last_lines_max do
    [_ | rest] = lines
    rest ++ [new_line]
  end

  defp keep_last(lines, new_line), do: lines ++ [new_line]
end
