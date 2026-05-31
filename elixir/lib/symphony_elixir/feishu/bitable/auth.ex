defmodule SymphonyElixir.Feishu.Bitable.Auth do
  @moduledoc """
  Manages Feishu tenant_access_token for Bitable API calls.
  Caches the token and refreshes before expiry.
  """

  use Agent

  require Logger

  @token_url "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
  # Refresh 5 minutes before actual expiry
  @refresh_buffer_seconds 300

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> %{token: nil, expires_at: 0} end, name: __MODULE__)
  end

  @spec tenant_access_token() :: {:ok, String.t()} | {:error, term()}
  def tenant_access_token do
    Agent.get_and_update(__MODULE__, &token_state_result/1)
  end

  defp fetch_token do
    with {:ok, app_id, app_secret} <- feishu_credentials(),
         {:ok, response} <- request_token(app_id, app_secret) do
      parse_token_response(response)
    end
  end

  defp token_state_result(state) do
    now = System.system_time(:second)

    if reusable_token?(state, now) do
      {{:ok, state.token}, state}
    else
      refreshed_token_state(now)
    end
  end

  defp reusable_token?(state, now) do
    is_binary(state.token) and state.expires_at > now + @refresh_buffer_seconds
  end

  defp refreshed_token_state(now) do
    case fetch_token() do
      {:ok, token, expires_in} ->
        {{:ok, token}, %{token: token, expires_at: now + expires_in}}

      {:error, reason} ->
        {{:error, reason}, %{token: nil, expires_at: 0}}
    end
  end

  defp feishu_credentials do
    app_id = System.get_env("FEISHU_APP_ID") || ""
    app_secret = System.get_env("FEISHU_APP_SECRET") || ""

    if app_id == "" or app_secret == "" do
      {:error, :missing_feishu_credentials}
    else
      {:ok, app_id, app_secret}
    end
  end

  defp request_token(app_id, app_secret) do
    case Req.post(@token_url,
           json: %{"app_id" => app_id, "app_secret" => app_secret},
           connect_options: [timeout: 10_000]
         ) do
      {:ok, response} -> {:ok, response}
      {:error, reason} -> {:error, {:feishu_auth_request_failed, reason}}
    end
  end

  defp parse_token_response(%Req.Response{status: 200, body: body}), do: parse_token_body(body)

  defp parse_token_response(%Req.Response{status: status}) do
    {:error, {:feishu_auth_http_error, status}}
  end

  defp parse_token_body(%{"code" => 0, "tenant_access_token" => token, "expire" => expires_in})
       when is_binary(token) and is_integer(expires_in) do
    Logger.debug("Feishu tenant_access_token refreshed, expires in #{expires_in}s")
    {:ok, token, expires_in}
  end

  defp parse_token_body(%{"code" => code, "msg" => msg}) do
    Logger.error("Feishu auth failed: code=#{code} msg=#{msg}")
    {:error, {:feishu_auth_failed, code, msg}}
  end

  defp parse_token_body(_body), do: {:error, :unexpected_auth_response}
end
