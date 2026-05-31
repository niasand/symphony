defmodule SymphonyElixir.Feishu.Bitable.Issue do
  @moduledoc """
  Converts Bitable records to SymphonyElixir.Linear.Issue structs.
  Reuses the existing Issue struct so the rest of Symphony doesn't need changes.
  """

  alias SymphonyElixir.Linear.Issue

  @spec from_record(map()) :: Issue.t()
  def from_record(%{"record_id" => record_id, "fields" => fields}) do
    %Issue{
      id: record_id,
      identifier: select_value(fields["Issue ID"]) || record_id,
      title: select_value(fields["Task"]) || "Untitled",
      description: fields["Description"],
      priority: parse_priority(select_value(fields["Priority"])),
      state: select_value(fields["Status"]) || "Open",
      branch_name: nil,
      url: nil,
      labels: parse_labels(fields["Labels"]),
      blocked_by: [],
      assigned_to_worker: true,
      created_at: nil,
      updated_at: nil
    }
  end

  def from_record(_record), do: %Issue{id: nil, identifier: nil, title: nil, state: "Open"}

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
