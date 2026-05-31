defmodule SymphonyElixir.Feishu.Bitable.Issue do
  @moduledoc """
  Converts Bitable records to SymphonyElixir.Tracker.Issue structs.
  """

  alias SymphonyElixir.Tracker.Issue

  @spec from_record(map()) :: Issue.t()
  def from_record(%{"record_id" => record_id, "fields" => fields}) do
    %Issue{
      id: record_id,
      identifier: select_value(fields["uuid"]) || record_id,
      title: select_value(fields["Task"]) || "Untitled",
      description: fields["Description"],
      priority: nil,
      state: select_value(fields["Status"]) || "Open",
      branch_name: nil,
      url: nil,
      labels: parse_labels(fields["Labels"]),
      blocked_by: [],
      assigned_to_worker: true,
      created_at: nil,
      updated_at: nil,
      parent_id: select_value(fields["Parent Issue"]),
      sub_task_ids: [],
      complexity: nil
    }
  end

  def from_record(_record), do: %Issue{id: nil, identifier: nil, title: nil, state: "Open"}

  defp select_value(value) when is_binary(value), do: value
  defp select_value([value | _]) when is_binary(value), do: value
  defp select_value(_), do: nil

  defp parse_labels([_ | _] = labels) when is_list(labels) do
    Enum.map(labels, &String.downcase/1)
  end

  defp parse_labels(label) when is_binary(label) and label != "" do
    [String.downcase(label)]
  end

  defp parse_labels(_), do: []
end
