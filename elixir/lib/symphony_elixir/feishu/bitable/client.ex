defmodule SymphonyElixir.Feishu.Bitable.Client do
  @moduledoc """
  HTTP client for Feishu Bitable (多维表格) REST API.
  Uses tenant_access_token for authentication.
  """

  require Logger

  alias SymphonyElixir.Feishu.Bitable.Auth

  @base_url "https://open.feishu.cn/open-apis/bitable/v1/apps"

  @spec list_records(String.t(), String.t(), keyword()) ::
          {:ok, [map()]} | {:error, term()}
  def list_records(app_token, table_id, opts \\ []) do
    filter = Keyword.get(opts, :filter)
    page_size = Keyword.get(opts, :page_size, 100)

    params = [page_size: page_size]
    params = if filter, do: Keyword.put(params, :filter, Jason.encode!(filter)), else: params

    with {:ok, token} <- Auth.tenant_access_token() do
      request(:get, "#{@base_url}/#{app_token}/tables/#{table_id}/records", token,
        params: params
      )
    end
  end

  @spec get_record(String.t(), String.t(), String.t()) ::
          {:ok, map()} | {:error, term()}
  def get_record(app_token, table_id, record_id) do
    with {:ok, token} <- Auth.tenant_access_token() do
      request(:get, "#{@base_url}/#{app_token}/tables/#{table_id}/records/#{record_id}", token)
    end
  end

  @spec update_record(String.t(), String.t(), String.t(), map()) ::
          {:ok, map()} | {:error, term()}
  def update_record(app_token, table_id, record_id, fields) do
    with {:ok, token} <- Auth.tenant_access_token() do
      request(
        :put,
        "#{@base_url}/#{app_token}/tables/#{table_id}/records/#{record_id}",
        token,
        json: %{"fields" => fields}
      )
    end
  end

  defp request(method, url, token, opts \\ []) do
    headers = [{"Authorization", "Bearer #{token}"}, {"Content-Type", "application/json"}]
    opts = Keyword.merge([connect_options: [timeout: 30_000], headers: headers], opts)

    req_opts = Keyword.merge([connect_options: [timeout: 30_000], headers: headers], opts)
    req_opts = Keyword.put(req_opts, :method, method)

    case Req.request(url, req_opts) do
      {:ok, %Req.Response{status: 200, body: body}} ->
        case body do
          %{"code" => 0, "data" => data} ->
            {:ok, data}

          %{"code" => code, "msg" => msg} ->
            Logger.warning("Feishu Bitable API error: code=#{code} msg=#{msg}")
            {:error, {:bitable_api_error, code, msg}}

          _ ->
            {:error, :unexpected_bitable_response}
        end

      {:ok, %Req.Response{status: status, body: body}} ->
        Logger.warning("Feishu Bitable HTTP #{status}: #{inspect(body)}")
        {:error, {:bitable_http_error, status}}

      {:error, reason} ->
        Logger.warning("Feishu Bitable request failed: #{inspect(reason)}")
        {:error, {:bitable_request_failed, reason}}
    end
  end
end
