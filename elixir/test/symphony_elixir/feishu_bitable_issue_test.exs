defmodule SymphonyElixir.Feishu.Bitable.IssueTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Feishu.Bitable.Issue

  test "normalizes uuid and project label from Bitable records" do
    issue =
      Issue.from_record(%{
        "record_id" => "rec-1",
        "fields" => %{
          "uuid" => "7f155a8e-7f12-4a96-8719-481c14c11780",
          "Task" => "Do the work",
          "Description" => "Details",
          "Status" => ["Open"],
          "Labels" => ["Symphony"]
        }
      })

    assert issue.id == "rec-1"
    assert issue.identifier == "7f155a8e-7f12-4a96-8719-481c14c11780"
    assert issue.title == "Do the work"
    assert issue.description == "Details"
    assert issue.state == "Open"
    assert issue.labels == ["symphony"]
    assert issue.priority == nil
    assert issue.branch_name == nil
  end
end
