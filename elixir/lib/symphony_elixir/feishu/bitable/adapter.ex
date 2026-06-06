defmodule SymphonyElixir.Feishu.Bitable.Adapter do
  @moduledoc """
  Feishu Bitable tracker adapter for Symphony.
  Implements the SymphonyElixir.Tracker behaviour.

  State lifecycle:
  - "Open" (active) → discovered by poll → dispatch → update to "In Progress"
  - "In Progress" (running) → agent executing → completion → update to "Resolved"/"Failed"
  - "Done"/"Resolved"/"Failed"/"Cancelled" (terminal)
  """

  @behaviour SymphonyElixir.Tracker

  require Logger

  alias SymphonyElixir.Feishu.Bitable.{Client, Issue}
  alias SymphonyElixir.Feishu.Webhook

  @impl true
  def fetch_candidate_issues do
    fetch_issues_by_states(config_module().settings!().tracker.active_states)
  end

  @impl true
  def fetch_issues_by_states(state_names) when is_list(state_names) do
    state_names =
      state_names
      |> Enum.filter(&is_binary/1)
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&(&1 == ""))

    case state_names do
      [] ->
        {:ok, []}

      _ ->
        fetch_records_for_states(state_names)
    end
  end

  @impl true
  def fetch_issue_states_by_ids(issue_ids) when is_list(issue_ids) do
    {:ok, Enum.flat_map(issue_ids, &fetch_issue_state_by_id/1)}
  end

  @impl true
  def create_comment(record_id, body) when is_binary(record_id) and is_binary(body) do
    with {:ok, current} <- Client.get_record(bitable_app_token(), bitable_table_id(), record_id) do
      existing = extract_text_field(current, "Comments")
      separator = if existing != "", do: "\n\n---\n\n", else: ""
      new_comment = "#{separator}[#{format_timestamp()}] #{body}"

      case Client.update_record(
             bitable_app_token(),
             bitable_table_id(),
             record_id,
             %{"Comments" => "#{existing}#{new_comment}"}
           ) do
        {:ok, _} -> :ok
        {:error, reason} -> {:error, reason}
      end
    end
  end

  @impl true
  def update_issue_state(record_id, state_name)
      when is_binary(record_id) and is_binary(state_name) do
    update_fields = %{"Status" => state_name}

    update_fields =
      case state_name do
        "In Progress" ->
          Map.merge(update_fields, %{
            "Comments" => "[#{format_timestamp()}] Claimed by #{agent_label()}"
          })

        state when state in ["Resolved", "Done"] ->
          Map.put(update_fields, "Completed At", System.system_time(:millisecond))

        _ ->
          update_fields
      end

    case Client.update_record(bitable_app_token(), bitable_table_id(), record_id, update_fields) do
      {:ok, _} ->
        Logger.info("Bitable record #{record_id} state updated to #{state_name}")
        maybe_send_lifecycle_notification(record_id, state_name)
        :ok

      {:error, reason} ->
        Logger.warning("Failed to update Bitable record #{record_id}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  @impl true
  def create_issue(attrs) when is_map(attrs) do
    fields = build_create_fields(attrs)

    case Client.create_record(bitable_app_token(), bitable_table_id(), fields) do
      {:ok, record} ->
        issue = Issue.from_record(record)
        send_lifecycle_notification(%{identifier: issue.identifier, title: issue.title, status: issue.state})
        {:ok, issue}

      {:error, reason} ->
        Logger.warning("Failed to create Bitable record: #{inspect(reason)}")
        {:error, reason}
    end
  end

  # Update record with status metadata that still exists in the Bitable schema.
  @spec update_record_with_metadata(String.t(), map()) :: :ok | {:error, term()}
  def update_record_with_metadata(record_id, metadata) when is_binary(record_id) and is_map(metadata) do
    fields = metadata_fields(metadata, record_id)

    if map_size(fields) > 0 do
      update_metadata_fields(record_id, metadata, fields)
    else
      Logger.debug("Bitable metadata update skipped for #{record_id}: no fields to update")
      :ok
    end
  end

  # --- Private helpers ---

  defp fetch_issue_state_by_id(record_id) do
    case Client.get_record(bitable_app_token(), bitable_table_id(), record_id) do
      {:ok, record} ->
        [Issue.from_record(record)]

      {:error, reason} ->
        Logger.debug("Bitable record #{record_id} not found: #{inspect(reason)}")
        []
    end
  end

  defp fetch_records_for_states(state_names) do
    Enum.reduce_while(state_names, {:ok, []}, fn state, {:ok, acc} ->
      filter = %{
        "conjunction" => "and",
        "conditions" => [
          %{"field_name" => "Status", "operator" => "is", "value" => [state]},
          %{"field_name" => "Labels", "operator" => "is", "value" => [bitable_project_label()]}
        ]
      }

      case Client.list_records(bitable_app_token(), bitable_table_id(), filter: filter) do
        {:ok, records} -> {:cont, {:ok, acc ++ Enum.map(records, &Issue.from_record/1)}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp metadata_fields(metadata, record_id) do
    %{}
    |> maybe_put_metadata_field(metadata, :state, "Status")
    |> maybe_put_metadata_field(metadata, :error, "Error")
    |> maybe_put_completed_at(metadata)
    |> maybe_put_mr_comment(metadata, record_id)
  end

  defp maybe_put_metadata_field(fields, metadata, key, bitable_field) do
    case Map.get(metadata, key) do
      nil -> fields
      false -> fields
      value -> Map.put(fields, bitable_field, value)
    end
  end

  defp maybe_put_completed_at(fields, %{state: state}) when state in ["Done", "Resolved", "Failed"] do
    Map.put(fields, "Completed At", System.system_time(:millisecond))
  end

  defp maybe_put_completed_at(fields, _metadata), do: fields

  defp maybe_put_mr_comment(fields, %{mr_url: mr_url}, record_id)
       when is_binary(mr_url) and mr_url != "" and is_binary(record_id) do
    existing = fetch_comments(record_id)
    separator = if existing && existing != "", do: "\n\n", else: ""
    comment = "#{existing}#{separator}[#{format_timestamp()}] MR created: #{mr_url}"
    Map.put(fields, "Comments", comment)
  end

  defp maybe_put_mr_comment(fields, _metadata, _record_id), do: fields

  defp fetch_comments(record_id) do
    case Client.get_record(bitable_app_token(), bitable_table_id(), record_id) do
      {:ok, data} -> extract_text_field(data, "Comments")
      _ -> ""
    end
  end

  defp update_metadata_fields(record_id, metadata, fields) do
    Logger.debug("Bitable metadata update for #{record_id}: #{inspect(Map.keys(fields))}")

    case Client.update_record(bitable_app_token(), bitable_table_id(), record_id, fields) do
      {:ok, _data} ->
        Logger.info("Bitable metadata updated for #{record_id} state=#{metadata[:state] || "unchanged"}")
        :ok

      {:error, reason} ->
        Logger.warning("Bitable metadata update FAILED for #{record_id}: #{inspect(reason)} fields=#{inspect(Map.keys(fields))}")

        {:error, reason}
    end
  end

  defp maybe_send_lifecycle_notification(record_id, "In Progress") do
    case Client.get_record(bitable_app_token(), bitable_table_id(), record_id) do
      {:ok, record} ->
        issue = Issue.from_record(record)
        send_lifecycle_notification(%{identifier: issue.identifier, title: issue.title, status: "In Progress"})

      {:error, reason} ->
        Logger.warning("Could not fetch Bitable record #{record_id} for lifecycle notification: #{inspect(reason)}")
    end
  end

  defp maybe_send_lifecycle_notification(_record_id, _state_name), do: :ok

  defp send_lifecycle_notification(notification) when is_map(notification) do
    notification =
      notification
      |> Map.put_new(:mr_url, nil)
      |> Map.put_new(:branch_name, nil)
      |> Map.put_new(:input_tokens, 0)
      |> Map.put_new(:output_tokens, 0)
      |> Map.put_new(:total_tokens, 0)
      |> Map.put_new(:error, nil)

    case Webhook.send_lifecycle_notification(notification) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("Feishu lifecycle webhook notification failed: #{inspect(reason)}")
    end
  end

  defp bitable_app_token do
    config_module().settings!().tracker.bitable_app_token ||
      System.get_env("FEISHU_BITABLE_APP_TOKEN") ||
      ""
  end

  defp bitable_table_id do
    config_module().settings!().tracker.bitable_table_id ||
      System.get_env("FEISHU_BITABLE_TABLE_ID") ||
      ""
  end

  defp bitable_project_label do
    (config_module().settings!().tracker.bitable_project_label ||
       System.get_env("FEISHU_BITABLE_PROJECT_LABEL") ||
       "")
    |> String.trim()
  end

  defp agent_label do
    config_module().settings!().agent.kind |> String.capitalize()
  end

  defp extract_text_field(data, field_name) do
    case data do
      %{"fields" => fields} when is_map(fields) ->
        case Map.get(fields, field_name) do
          value when is_binary(value) -> value
          [value | _] when is_binary(value) -> value
          _ -> ""
        end

      _ ->
        ""
    end
  end

  defp format_timestamp do
    DateTime.utc_now() |> DateTime.add(28_800, :second) |> Calendar.strftime("%Y-%m-%d %H:%M:%S")
  end

  defp config_module, do: SymphonyElixir.Config

  defp build_create_fields(attrs) do
    %{}
    |> Map.put("uuid", issue_uuid(attrs))
    |> maybe_put_field(attrs, :title, "Task")
    |> maybe_put_field(attrs, :description, "Description")
    |> maybe_put_field(attrs, :state, "Status")
    |> maybe_put_field(attrs, :parent_id, "Parent Issue ID")
    |> Map.put("Labels", bitable_project_label())
  end

  defp issue_uuid(%{uuid: uuid}) when is_binary(uuid) and uuid != "" do
    uuid
  end

  defp issue_uuid(%{"uuid" => uuid}) when is_binary(uuid) and uuid != "" do
    uuid
  end

  defp issue_uuid(_attrs), do: Ecto.UUID.generate()

  defp maybe_put_field(fields, attrs, source_key, bitable_field) do
    case Map.get(attrs, source_key) do
      nil -> fields
      value -> Map.put(fields, bitable_field, value)
    end
  end
end
