defmodule SymphonyElixir.Feishu.Webhook do
  @moduledoc """
  Sends task lifecycle notifications via Feishu webhook.

  Uses Feishu's custom bot webhook API to send interactive card messages
  with task completion details.
  """

  require Logger

  @type notification :: %{
          identifier: String.t(),
          title: String.t(),
          status: String.t(),
          mr_url: String.t() | nil,
          branch_name: String.t() | nil,
          input_tokens: non_neg_integer(),
          output_tokens: non_neg_integer(),
          total_tokens: non_neg_integer(),
          error: String.t() | nil
        }

  @spec send_lifecycle_notification(notification()) :: :ok | {:error, term()}
  def send_lifecycle_notification(%{} = notification) do
    webhook_url = fetch_webhook_url()

    case webhook_url do
      nil ->
        Logger.debug("Feishu webhook URL not configured; skipping notification")
        :ok

      url when is_binary(url) ->
        payload = build_card_payload(notification)
        opts = Keyword.merge([json: payload, connect_options: [timeout: 10_000]], req_options())

        case Req.post(url, opts) do
          {:ok, %Req.Response{status: 200, body: %{"code" => 0}}} ->
            Logger.info("Feishu webhook notification sent for #{notification.identifier}")
            :ok

          {:ok, %Req.Response{status: 200, body: %{"code" => code, "msg" => msg}}} ->
            Logger.warning("Feishu webhook rejected: code=#{code} msg=#{msg}")
            {:error, {:webhook_rejected, code, msg}}

          {:ok, %Req.Response{status: status, body: body}} ->
            Logger.warning("Feishu webhook HTTP #{status}: #{inspect(body)}")
            {:error, {:webhook_http_error, status}}

          {:error, reason} ->
            Logger.warning("Feishu webhook request failed: #{inspect(reason)}")
            {:error, {:webhook_request_failed, reason}}
        end
    end
  end

  @spec send_completion_notification(notification()) :: :ok | {:error, term()}
  def send_completion_notification(%{} = notification), do: send_lifecycle_notification(notification)

  # --- Private helpers ---

  defp fetch_webhook_url do
    case SymphonyElixir.Config.settings!().notifications do
      %{feishu_webhook_url: url} when is_binary(url) and url != "" ->
        resolve_webhook_url(url)

      _ ->
        System.get_env("FEISHU_WEBHOOK_URL")
    end
  end

  defp resolve_webhook_url("$" <> env_name = url) when is_binary(url) do
    if String.match?(env_name, ~r/^[A-Za-z_][A-Za-z0-9_]*$/) do
      System.get_env(env_name) || url
    else
      url
    end
  end

  defp resolve_webhook_url(url), do: url

  defp req_options do
    Application.get_env(:symphony_elixir, :feishu_webhook_req_options, [])
  end

  defp build_card_payload(notification) do
    status = Map.get(notification, :status, "Unknown")
    {title_text, header_color} = status_display(status)

    elements = [
      build_lark_md_element("**Task:** #{Map.get(notification, :identifier, "N/A")}"),
      build_lark_md_element("**Title:** #{Map.get(notification, :title, "N/A")}")
    ]

    elements =
      case Map.get(notification, :mr_url) do
        url when is_binary(url) and url != "" ->
          elements ++ [build_lark_md_element("**MR:** [View MR](#{url})")]

        _ ->
          elements
      end

    elements =
      case Map.get(notification, :branch_name) do
        branch when is_binary(branch) and branch != "" ->
          elements ++ [build_lark_md_element("**Branch:** `#{branch}`")]

        _ ->
          elements
      end

    # Token usage
    total_tokens = Map.get(notification, :total_tokens, 0)

    elements =
      if total_tokens > 0 do
        elements ++
          [
            build_lark_md_element(
              "**Tokens:** #{format_number(total_tokens)} total (#{format_number(Map.get(notification, :input_tokens, 0))} in / #{format_number(Map.get(notification, :output_tokens, 0))} out)"
            )
          ]
      else
        elements
      end

    # Error info
    elements =
      case Map.get(notification, :error) do
        error when is_binary(error) and error != "" ->
          elements ++ [build_lark_md_element("**Error:** #{error}")]

        _ ->
          elements
      end

    elements = elements ++ [build_timestamp_element()]

    %{
      "msg_type" => "interactive",
      "card" => %{
        "header" => %{
          "title" => %{"tag" => "plain_text", "content" => title_text},
          "template" => header_color
        },
        "elements" => elements
      }
    }
  end

  defp status_display("Resolved"), do: {"✅ Task Completed", "green"}
  defp status_display("Failed"), do: {"❌ Task Failed", "red"}
  defp status_display("In Progress"), do: {"🔄 Task In Progress", "blue"}
  defp status_display("Open"), do: {"📋 Task Created", "blue"}
  defp status_display(other), do: {"📋 Task #{other}", "blue"}

  defp build_lark_md_element(content) do
    %{
      "tag" => "div",
      "text" => %{"tag" => "lark_md", "content" => content}
    }
  end

  defp build_timestamp_element do
    timestamp =
      DateTime.utc_now()
      |> DateTime.add(28_800, :second)
      |> Calendar.strftime("%Y-%m-%d %H:%M:%S")

    build_lark_md_element("---\n🕐 #{timestamp} (UTC+8)")
  end

  defp format_number(n) when is_integer(n) do
    n
    |> Integer.to_string()
    |> String.graphemes()
    |> Enum.reverse()
    |> Enum.chunk_every(3)
    |> Enum.join(",")
    |> String.reverse()
  end

  defp format_number(_), do: "0"
end
