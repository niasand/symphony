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

  @impl true
  def fetch_candidate_issues do
    fetch_issues_by_states(config_module().settings!().tracker.active_states)
  end

  @impl true
  def fetch_issues_by_states(state_names) when is_list(state_names) do
    conditions =
      state_names
      |> Enum.filter(&is_binary/1)
      |> Enum.map(fn state ->
        %{"field_name" => "Status", "operator" => "is", "value" => [state]}
      end)

    case conditions do
      [] ->
        {:ok, []}

      _ ->
        filter = %{"conjunction" => "or", "conditions" => conditions}

        with {:ok, data} <- Client.list_records(bitable_app_token(), bitable_table_id(), filter: filter) do
          records = parse_records(data)
          {:ok, Enum.map(records, &Issue.from_record/1)}
        end
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
      separator = if existing && existing != "", do: "\n\n---\n\n", else: ""
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
            "Agent" => agent_label(),
            "Comments" => "[#{format_timestamp()}] Claimed by #{agent_label()}"
          })

        "Resolved" ->
          Map.put(update_fields, "Completed At", System.system_time(:millisecond))

        _ ->
          update_fields
      end

    case Client.update_record(bitable_app_token(), bitable_table_id(), record_id, update_fields) do
      {:ok, _} ->
        Logger.info("Bitable record #{record_id} state updated to #{state_name}")
        :ok

      {:error, reason} ->
        Logger.warning("Failed to update Bitable record #{record_id}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  # Update record with full metadata (tokens, error, etc.)
  @spec update_record_with_metadata(String.t(), map()) :: :ok | {:error, term()}
  def update_record_with_metadata(record_id, metadata) when is_binary(record_id) and is_map(metadata) do
    fields = metadata_fields(metadata)

    if map_size(fields) > 0 do
      update_metadata_fields(record_id, metadata, fields)
    else
      Logger.debug("Bitable metadata update skipped for #{record_id}: no fields to update")
      :ok
    end
  end

  # --- Private helpers ---

  defp fetch_issue_state_by_id(record_id) do
    with {:ok, data} <- Client.get_record(bitable_app_token(), bitable_table_id(), record_id),
         record when not is_nil(record) <- extract_record(data) do
      [Issue.from_record(record)]
    else
      nil ->
        []

      {:error, reason} ->
        Logger.debug("Bitable record #{record_id} not found: #{inspect(reason)}")
        []
    end
  end

  defp metadata_fields(metadata) do
    %{}
    |> maybe_put_metadata_field(metadata, :state, "Status")
    |> maybe_put_metadata_field(metadata, :input_tokens, "Token Input")
    |> maybe_put_metadata_field(metadata, :output_tokens, "Token Output")
    |> maybe_put_metadata_field(metadata, :total_tokens, "Token Total")
    |> maybe_put_metadata_field(metadata, :error, "Error")
    |> maybe_put_metadata_field(metadata, :branch_name, "Branch")
    |> maybe_put_metadata_field(metadata, :retry_count, "Retries")
    |> maybe_put_completed_at(metadata)
  end

  defp maybe_put_metadata_field(fields, metadata, key, bitable_field) do
    case Map.get(metadata, key) do
      nil -> fields
      false -> fields
      value -> Map.put(fields, bitable_field, value)
    end
  end

  defp maybe_put_completed_at(fields, %{state: state}) when state in ["Resolved", "Failed"] do
    Map.put(fields, "Completed At", System.system_time(:millisecond))
  end

  defp maybe_put_completed_at(fields, _metadata), do: fields

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

  defp agent_label do
    config_module().settings!().agent.kind |> String.capitalize()
  end

  defp parse_records(records) when is_list(records), do: records
  defp parse_records(%{"items" => items}) when is_list(items), do: items
  defp parse_records(_), do: []

  defp extract_record(%{"record" => record}) when is_map(record), do: record
  defp extract_record(record) when is_map(record), do: record
  defp extract_record(_), do: nil

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
end
