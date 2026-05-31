defmodule SymphonyElixir.Feishu.Bitable.Issue do
  @moduledoc """
  Converts Bitable records to SymphonyElixir.Linear.Issue structs.
  Reuses the existing Issue struct so the rest of Symphony doesn't need changes.
  """

  alias SymphonyElixir.Linear.Issue

  @doc """
  Converts a Bitable record (from list_records API) to an Issue struct.

  Bitable record format:
  %{
    "record_id" => "recvlaWqjccMFO",
    "fields" => %{
      "任务名称" => "Some task",
      "任务描述" => "...",
      "Issue ID" => "SYM-001",
      "优先级" => "P1",
      "任务状态" => ["待处理"],  # select fields return arrays
      "执行者" => ["Claude"],
      ...
    }
  }
  """
  @spec from_record(map()) :: Issue.t()
  def from_record(%{"record_id" => record_id, "fields" => fields}) do
    %Issue{
      id: record_id,
      identifier: select_value(fields["Issue ID"]) || record_id,
      title: select_value(fields["任务名称"]) || "Untitled",
      description: fields["任务描述"],
      priority: parse_priority(select_value(fields["优先级"])),
      state: select_value(fields["任务状态"]) || "待处理",
      branch_name: nil,
      url: nil,
      labels: parse_labels(fields["标签"]),
      blocked_by: [],
      assigned_to_worker: true,
      created_at: nil,
      updated_at: nil
    }
  end

  def from_record(_record), do: %Issue{id: nil, identifier: nil, title: nil, state: "待处理"}

  # Bitable select fields may be: "value" (search API) or ["value"] (list API)
  defp select_value(value) when is_binary(value), do: value
  defp select_value([value | _]) when is_binary(value), do: value
  defp select_value(_), do: nil

  defp parse_priority("P0"), do: 1
  defp parse_priority("P1"), do: 2
  defp parse_priority("P2"), do: 3
  defp parse_priority("P3"), do: 4
  defp parse_priority(_), do: nil

  defp parse_labels([_ | _] = labels) when is_list(labels) do
    Enum.map(labels, &String.downcase/1)
  end

  defp parse_labels(_), do: []
end
