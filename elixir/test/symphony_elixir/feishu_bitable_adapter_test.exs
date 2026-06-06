defmodule SymphonyElixir.Feishu.Bitable.AdapterTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Feishu.Bitable.Adapter

  defmodule FakeClient do
    def create_record(_app_token, _table_id, fields) do
      record = %{"record_id" => "rec-created", "fields" => fields}
      Agent.update(agent(), &Map.put(&1, "rec-created", record))
      {:ok, record}
    end

    def update_record(_app_token, _table_id, record_id, fields) do
      if Application.get_env(:symphony_elixir, :fake_bitable_update_error) do
        {:error, :fake_update_failed}
      else
        updated =
          Agent.get_and_update(agent(), fn records ->
            record = Map.get(records, record_id, %{"record_id" => record_id, "fields" => %{}})
            updated = put_in(record, ["fields"], Map.merge(record["fields"], fields))
            {updated, Map.put(records, record_id, updated)}
          end)

        {:ok, updated}
      end
    end

    def get_record(_app_token, _table_id, record_id) do
      if Application.get_env(:symphony_elixir, :fake_bitable_get_error) do
        {:error, :fake_get_failed}
      else
        case Agent.get(agent(), &Map.get(&1, record_id)) do
          nil -> {:error, :not_found}
          record -> {:ok, record}
        end
      end
    end

    def list_records(_app_token, _table_id, _opts), do: {:ok, []}

    defp agent do
      Application.fetch_env!(:symphony_elixir, :fake_bitable_client_agent)
    end
  end

  setup do
    previous_url = System.get_env("FEISHU_WEBHOOK_URL")
    previous_req_options = Application.get_env(:symphony_elixir, :feishu_webhook_req_options)
    previous_client = Application.get_env(:symphony_elixir, :bitable_client_module)
    previous_fake_error = Application.get_env(:symphony_elixir, :fake_bitable_update_error)
    previous_fake_get_error = Application.get_env(:symphony_elixir, :fake_bitable_get_error)

    {:ok, agent} = Agent.start_link(fn -> %{} end)

    System.put_env("FEISHU_WEBHOOK_URL", "https://example.invalid/notify")
    Application.put_env(:symphony_elixir, :feishu_webhook_req_options, plug: {Req.Test, __MODULE__})
    Application.put_env(:symphony_elixir, :bitable_client_module, FakeClient)
    Application.put_env(:symphony_elixir, :fake_bitable_client_agent, agent)

    on_exit(fn ->
      restore_env("FEISHU_WEBHOOK_URL", previous_url)
      restore_app_env(:feishu_webhook_req_options, previous_req_options)
      restore_app_env(:bitable_client_module, previous_client)
      restore_app_env(:fake_bitable_update_error, previous_fake_error)
      restore_app_env(:fake_bitable_get_error, previous_fake_get_error)
      Application.delete_env(:symphony_elixir, :fake_bitable_client_agent)
    end)

    %{agent: agent}
  end

  test "create_issue sends lifecycle notification for created state" do
    expect_webhook()

    assert {:ok, issue} =
             Adapter.create_issue(%{
               uuid: "MT-CREATED",
               title: "Created task",
               state: "Open"
             })

    assert issue.identifier == "MT-CREATED"
    assert_receive {:webhook_payload, payload}
    assert get_in(payload, ["card", "header", "title", "content"]) == "📋 Task Created"
    assert payload_text(payload) =~ "**Task:** MT-CREATED"
    assert payload_text(payload) =~ "**Title:** Created task"
  end

  test "update_issue_state sends lifecycle notification for every requested state", %{agent: agent} do
    put_record(agent, "rec-claimed", %{"uuid" => "MT-CLAIMED", "Task" => "Claimed task", "Status" => "Open"})
    expect_webhook()

    assert :ok = Adapter.update_issue_state("rec-claimed", "In Review")

    assert_receive {:webhook_payload, payload}
    assert get_in(payload, ["card", "header", "title", "content"]) == "📋 Task In Review"
    assert payload_text(payload) =~ "**Task:** MT-CLAIMED"
    assert payload_text(payload) =~ "**Title:** Claimed task"
  end

  test "metadata state update sends lifecycle notification", %{agent: agent} do
    put_record(agent, "rec-failed", %{"uuid" => "MT-FAILED", "Task" => "Failed task", "Status" => "In Progress"})
    expect_webhook()

    assert :ok = Adapter.update_record_with_metadata("rec-failed", %{state: "Failed", error: "boom"})

    assert_receive {:webhook_payload, payload}
    assert get_in(payload, ["card", "header", "title", "content"]) == "❌ Task Failed"
    assert payload_text(payload) =~ "**Task:** MT-FAILED"
    assert payload_text(payload) =~ "**Title:** Failed task"
  end

  test "completion metadata notification includes MR, branch, and token details", %{agent: agent} do
    put_record(agent, "rec-done", %{"uuid" => "MT-DONE", "Task" => "Done task", "Status" => "In Progress"})
    expect_webhook()

    assert :ok =
             Adapter.update_record_with_metadata("rec-done", %{
               state: "Done",
               mr_url: "https://example.invalid/mr/1",
               branch_name: "feature/status-notify",
               input_tokens: 12_345,
               output_tokens: 678,
               total_tokens: 13_023
             })

    assert_receive {:webhook_payload, payload}
    text = payload_text(payload)
    assert get_in(payload, ["card", "header", "title", "content"]) == "📋 Task Done"
    assert text =~ "**Task:** MT-DONE"
    assert text =~ "**Title:** Done task"
    assert text =~ "**MR:** [View MR](https://example.invalid/mr/1)"
    assert text =~ "**Branch:** `feature/status-notify`"
    assert text =~ "**Tokens:** 13,023 total (12,345 in / 678 out)"
  end

  test "metadata without state does not send lifecycle notification", %{agent: agent} do
    put_record(agent, "rec-metadata", %{"uuid" => "MT-META", "Task" => "Metadata task", "Status" => "In Progress"})

    assert :ok = Adapter.update_record_with_metadata("rec-metadata", %{error: "still running"})

    refute_receive {:webhook_payload, _payload}, 100
  end

  test "failed Bitable update does not send lifecycle notification", %{agent: agent} do
    put_record(agent, "rec-error", %{"uuid" => "MT-ERROR", "Task" => "Error task", "Status" => "Open"})
    Application.put_env(:symphony_elixir, :fake_bitable_update_error, true)

    assert {:error, :fake_update_failed} = Adapter.update_issue_state("rec-error", "In Progress")

    refute_receive {:webhook_payload, _payload}, 100
  end

  test "missing webhook configuration does not fail tracker update", %{agent: agent} do
    put_record(agent, "rec-no-webhook", %{"uuid" => "MT-NO-WEBHOOK", "Task" => "No webhook task", "Status" => "Open"})
    System.delete_env("FEISHU_WEBHOOK_URL")

    log =
      capture_log(fn ->
        assert :ok = Adapter.update_issue_state("rec-no-webhook", "In Progress")
      end)

    refute log =~ "Feishu lifecycle webhook notification failed"
  end

  test "record fetch failure after state update does not fail tracker update" do
    Application.put_env(:symphony_elixir, :fake_bitable_get_error, true)

    log =
      capture_log(fn ->
        assert :ok = Adapter.update_issue_state("rec-fetch-fails", "In Progress")
      end)

    assert log =~ "Could not fetch Bitable record rec-fetch-fails for lifecycle notification"
    assert log =~ ":fake_get_failed"
    refute_receive {:webhook_payload, _payload}, 100
  end

  test "webhook failure is logged with notification fields and does not fail tracker update", %{agent: agent} do
    put_record(agent, "rec-webhook-fail", %{
      "uuid" => "MT-WEBHOOK-FAIL",
      "Task" => "Webhook failure task",
      "Status" => "Open"
    })

    Req.Test.expect(__MODULE__, fn conn ->
      Req.Test.json(conn, %{"code" => 190_001, "msg" => "fake rejected"})
    end)

    log =
      capture_log(fn ->
        assert :ok = Adapter.update_issue_state("rec-webhook-fail", "In Progress")
      end)

    assert log =~ "Feishu lifecycle webhook notification failed"
    assert log =~ "notification_id=bitable:rec-webhook-fail:in-progress"
    assert log =~ "record_id=rec-webhook-fail"
    assert log =~ "issue_identifier=MT-WEBHOOK-FAIL"
    assert log =~ "status=In Progress"
  end

  defp expect_webhook do
    test_pid = self()

    Req.Test.expect(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(test_pid, {:webhook_payload, Jason.decode!(body)})
      Req.Test.json(conn, %{"code" => 0})
    end)
  end

  defp put_record(agent, record_id, fields) do
    record = %{"record_id" => record_id, "fields" => fields}
    Agent.update(agent, &Map.put(&1, record_id, record))
  end

  defp payload_text(payload) do
    payload
    |> get_in(["card", "elements"])
    |> Enum.map_join("\n", &get_in(&1, ["text", "content"]))
  end

  defp restore_app_env(key, nil), do: Application.delete_env(:symphony_elixir, key)
  defp restore_app_env(key, value), do: Application.put_env(:symphony_elixir, key, value)
end
