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

  def start_link(_opts \\ []) do
    Agent.start_link(fn -> %{token: nil, expires_at: 0} end, name: __MODULE__)
  end

  @spec tenant_access_token() :: {:ok, String.t()} | {:error, term()}
  def tenant_access_token do
    Agent.get_and_update(__MODULE__, fn state ->
      now = System.system_time(:second)

      if is_binary(state.token) and state.expires_at > now + @refresh_buffer_seconds do
        {{:ok, state.token}, state}
      else
        case fetch_token() do
          {:ok, token, expires_in} ->
            new_state = %{token: token, expires_at: now + expires_in}
            {{:ok, token}, new_state}

          {:error, reason} ->
            {{:error, reason}, %{token: nil, expires_at: 0}}
        end
      end
    end)
  end

  defp fetch_token do
    app_id = System.get_env("FEISHU_APP_ID") || ""
    app_secret = System.get_env("FEISHU_APP_SECRET") || ""

    if app_id == "" or app_secret == "" do
      {:error, :missing_feishu_credentials}
    else
      case Req.post(@token_url,
             json: %{"app_id" => app_id, "app_secret" => app_secret},
             connect_options: [timeout: 10_000]
           ) do
        {:ok, %Req.Response{status: 200, body: body}} ->
          case body do
            %{"code" => 0, "tenant_access_token" => token, "expire" => expires_in}
            when is_binary(token) and is_integer(expires_in) ->
              Logger.debug("Feishu tenant_access_token refreshed, expires in #{expires_in}s")
              {:ok, token, expires_in}

            %{"code" => code, "msg" => msg} ->
              Logger.error("Feishu auth failed: code=#{code} msg=#{msg}")
              {:error, {:feishu_auth_failed, code, msg}}

            _ ->
              {:error, :unexpected_auth_response}
          end

        {:ok, %Req.Response{status: status}} ->
          {:error, {:feishu_auth_http_error, status}}

        {:error, reason} ->
          {:error, {:feishu_auth_request_failed, reason}}
      end
    end
  end
end
