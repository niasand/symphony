defmodule SymphonyElixir.Feishu.Bitable.Client do
  @moduledoc """
  HTTP client for Feishu Bitable (多维表格) REST API.
  Uses tenant_access_token for authentication.
  """

  require Logger

  alias SymphonyElixir.Feishu.Bitable.Auth

  @base_url "https://open.feishu.cn/open-apis/bitable/v1/apps"

  @type response_data :: map() | [map()]

  @spec list_records(String.t(), String.t(), keyword()) ::
          {:ok, [map()]} | {:error, term()}
  def list_records(app_token, table_id, opts \\ []) do
    filter = Keyword.get(opts, :filter)
    page_size = Keyword.get(opts, :page_size, 100)

    with {:ok, token} <- Auth.tenant_access_token(),
         {:ok, records} <- list_records_request(app_token, table_id, token, filter, page_size) do
      expect_list(records)
    end
  end

  @spec get_record(String.t(), String.t(), String.t()) ::
          {:ok, map()} | {:error, term()}
  def get_record(app_token, table_id, record_id) do
    with {:ok, token} <- Auth.tenant_access_token(),
         {:ok, record} <- request(:get, "#{@base_url}/#{app_token}/tables/#{table_id}/records/#{record_id}", token) do
      expect_map(record)
    end
  end

  @spec update_record(String.t(), String.t(), String.t(), map()) ::
          {:ok, map()} | {:error, term()}
  def update_record(app_token, table_id, record_id, fields) do
    with {:ok, token} <- Auth.tenant_access_token(),
         {:ok, record} <-
           request(
             :put,
             "#{@base_url}/#{app_token}/tables/#{table_id}/records/#{record_id}",
             token,
             json: %{"fields" => fields}
           ) do
      expect_map(record)
    end
  end

  @spec create_record(String.t(), String.t(), map()) ::
          {:ok, map()} | {:error, term()}
  def create_record(app_token, table_id, fields) do
    with {:ok, token} <- Auth.tenant_access_token(),
         {:ok, record} <-
           request(
             :post,
             "#{@base_url}/#{app_token}/tables/#{table_id}/records",
             token,
             json: %{"fields" => fields}
           ) do
      expect_map(record)
    end
  end

  defp list_records_request(app_token, table_id, token, filter, page_size) do
    if filter do
      request(
        :post,
        "#{@base_url}/#{app_token}/tables/#{table_id}/records/search",
        token,
        json: %{"page_size" => page_size, "filter" => filter}
      )
    else
      request(
        :get,
        "#{@base_url}/#{app_token}/tables/#{table_id}/records",
        token,
        params: [page_size: page_size]
      )
    end
  end

  defp expect_list(records) when is_list(records), do: {:ok, records}
  defp expect_list(_records), do: {:error, :unexpected_bitable_response}

  defp expect_map(record) when is_map(record), do: {:ok, record}
  defp expect_map(_record), do: {:error, :unexpected_bitable_response}

  @spec request(atom(), String.t(), String.t(), keyword()) ::
          {:ok, response_data()} | {:error, term()}
  defp request(method, url, token, opts \\ []) do
    headers = [{"authorization", "Bearer #{token}"}, {"content-type", "application/json"}]

    opts =
      opts
      |> Keyword.put(:connect_options, timeout: 30_000)
      |> Keyword.put(:headers, headers)
      |> Keyword.put(:method, method)
      |> Keyword.put(:url, url)

    case Req.request(opts) do
      {:ok, %Req.Response{status: 200, body: body}} ->
        case body do
          %{"code" => 0, "data" => data} ->
            {:ok, normalize_records(data)}

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

  # Search API: %{"items" => [...], "total" => N, "has_more" => bool}
  defp normalize_records(%{"items" => items}) when is_list(items) do
    items
    |> Enum.map(&flatten_record_fields/1)
  end

  # GET list API: %{"data" => [[...], ...], "fields" => [...], "record_id_list" => [...]}
  defp normalize_records(%{"data" => rows, "fields" => field_names, "record_id_list" => record_ids})
       when is_list(rows) and is_list(field_names) and is_list(record_ids) do
    Enum.zip_with([record_ids, rows], fn [record_id, row] ->
      fields = Enum.zip(field_names, row) |> Map.new()
      %{"record_id" => record_id, "fields" => fields}
    end)
  end

  # Single record (get_record / update_record)
  defp normalize_records(%{"record" => record}) when is_map(record), do: flatten_record_fields(record)
  defp normalize_records(%{"record_id" => _} = record), do: flatten_record_fields(record)

  defp normalize_records(data), do: data

  # Text fields in search API come as [{"text": "...", "type": "text"}]
  # Flatten them to plain strings for easier consumption
  defp flatten_record_fields(%{"record_id" => rid, "fields" => fields}) when is_map(fields) do
    %{"record_id" => rid, "fields" => Map.new(fields, fn {k, v} -> {k, flatten_value(v)} end)}
  end

  defp flatten_record_fields(record), do: record

  defp flatten_value([%{"text" => text, "type" => "text"} | _]), do: text
  defp flatten_value([%{"text" => text} | _]), do: text
  defp flatten_value(value), do: value
end
