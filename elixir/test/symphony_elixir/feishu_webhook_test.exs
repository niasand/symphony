defmodule SymphonyElixir.Feishu.WebhookTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Feishu.Webhook

  setup do
    previous_url = System.get_env("FEISHU_WEBHOOK_URL")
    previous_req_options = Application.get_env(:symphony_elixir, :feishu_webhook_req_options)

    System.put_env("FEISHU_WEBHOOK_URL", "https://example.invalid/notify")
    Application.put_env(:symphony_elixir, :feishu_webhook_req_options, plug: {Req.Test, __MODULE__})

    on_exit(fn ->
      restore_env("FEISHU_WEBHOOK_URL", previous_url)

      if previous_req_options do
        Application.put_env(:symphony_elixir, :feishu_webhook_req_options, previous_req_options)
      else
        Application.delete_env(:symphony_elixir, :feishu_webhook_req_options)
      end
    end)

    :ok
  end

  test "sends task created lifecycle card" do
    test_pid = self()

    Req.Test.expect(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(test_pid, {:webhook_payload, Jason.decode!(body)})
      Req.Test.json(conn, %{"code" => 0})
    end)

    assert :ok =
             Webhook.send_lifecycle_notification(%{
               identifier: "MT-100",
               title: "Create task notification",
               status: "Open"
             })

    assert_receive {:webhook_payload, payload}
    assert get_in(payload, ["card", "header", "title", "content"]) == "📋 Task Created"
    assert payload_text(payload) =~ "**Task:** MT-100"
    assert payload_text(payload) =~ "**Title:** Create task notification"
  end

  test "sends task in progress lifecycle card" do
    test_pid = self()

    Req.Test.expect(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(test_pid, {:webhook_payload, Jason.decode!(body)})
      Req.Test.json(conn, %{"code" => 0})
    end)

    assert :ok =
             Webhook.send_lifecycle_notification(%{
               identifier: "MT-101",
               title: "Claim task notification",
               status: "In Progress"
             })

    assert_receive {:webhook_payload, payload}
    assert get_in(payload, ["card", "header", "title", "content"]) == "🔄 Task In Progress"
    assert payload_text(payload) =~ "**Task:** MT-101"
    assert payload_text(payload) =~ "**Title:** Claim task notification"
  end

  test "sends generic lifecycle card for custom states" do
    test_pid = self()

    Req.Test.expect(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(test_pid, {:webhook_payload, Jason.decode!(body)})
      Req.Test.json(conn, %{"code" => 0})
    end)

    assert :ok =
             Webhook.send_lifecycle_notification(%{
               identifier: "MT-102",
               title: "Review task notification",
               status: "In Review"
             })

    assert_receive {:webhook_payload, payload}
    assert get_in(payload, ["card", "header", "title", "content"]) == "📋 Task In Review"
    assert payload_text(payload) =~ "**Task:** MT-102"
    assert payload_text(payload) =~ "**Title:** Review task notification"
  end

  defp payload_text(payload) do
    payload
    |> get_in(["card", "elements"])
    |> Enum.map_join("\n", &get_in(&1, ["text", "content"]))
  end
end
