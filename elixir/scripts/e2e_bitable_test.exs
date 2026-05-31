# E2E 验证：飞书 Bitable Tracker Adapter
#
# 流程：
# 1. 用 Bitable Adapter 查询"待处理"任务
# 2. 更新状态为"进行中" + 回写评论
# 3. 用 Claude CLI 执行实际任务
# 4. 更新状态为"已完成" + 回写完成时间
#
# 运行：mix run scripts/e2e_bitable_test.exs

# Ensure Auth agent is started
case SymphonyElixir.Feishu.Bitable.Auth.start_link() do
  {:ok, _} -> :ok
  {:error, {:already_started, _}} -> :ok
end

alias SymphonyElixir.Feishu.Bitable.{Adapter, Issue}

record_id = "recvlbLuz4sNq0"

IO.puts("\n=== Step 1: Fetch candidate issues (待处理) ===")

# Use Bitable-native state names instead of config defaults
case Adapter.fetch_issues_by_states(["Open"]) do
  {:ok, issues} ->
    IO.puts("Found #{length(issues)} candidate issues:")
    for issue <- issues do
      IO.puts("  - #{issue.identifier}: #{issue.title} (state=#{issue.state}, labels=#{inspect(issue.labels)})")
    end

    target = Enum.find(issues, &(&1.id == record_id))

    if target do
      IO.puts("\n✓ Target task found: #{target.title}")

      # Step 2: Claim — update to In Progress
      IO.puts("\n=== Step 2: Claim task → In Progress ===")

      case Adapter.update_issue_state(record_id, "In Progress") do
        :ok ->
          IO.puts("✓ Status updated to 进行中")

          # Step 3: Run Claude CLI
          IO.puts("\n=== Step 3: Execute with Claude CLI ===")

          workspace = System.tmp_dir!() |> Path.join("symphony_e2e_test")
          File.mkdir_p!(workspace)

          {output, exit_code} = System.cmd("claude", [
            "-p",
            "在当前目录下创建 hello.txt，写入 Hello from Symphony!，然后读取确认内容正确。完成后输出 DONE。",
            "--output-format", "stream-json",
            "--verbose",
            "--max-turns", "5"
          ], cd: workspace, stderr_to_stdout: true)

          # Parse the final result event for token usage
          {input_tokens, output_tokens, total_tokens} =
            output
            |> String.split("\n")
            |> Enum.filter(&String.starts_with?(&1, "{"))
            |> Enum.reduce({0, 0, 0}, fn line, acc ->
              case Jason.decode(line) do
                {:ok, %{"type" => "result", "usage" => usage}} when is_map(usage) ->
                  it = Map.get(usage, "input_tokens", 0)
                  ot = Map.get(usage, "output_tokens", 0)
                  {it, ot, it + ot}

                {:ok, %{"type" => "result", "modelUsage" => mu}} when is_map(mu) ->
                  {it, ot} =
                    mu |> Map.values() |> Enum.reduce({0, 0}, fn m, {i, o} ->
                      {i + Map.get(m, "inputTokens", 0), o + Map.get(m, "outputTokens", 0)}
                    end)
                  {it, ot, it + ot}

                _ ->
                  acc
              end
            end)

          cost = 0
          duration = 0

          success = exit_code == 0 || String.contains?(output, "DONE")

          IO.puts("  exit_code: #{exit_code}")
          IO.puts("  tokens observed locally: input=#{input_tokens} output=#{output_tokens} total=#{total_tokens}")
          IO.puts("  cost: $#{cost}")
          IO.puts("  duration: #{duration}ms")
          IO.puts("  success: #{success}")

          # Verify file
          case File.read(Path.join(workspace, "hello.txt")) do
            {:ok, content} ->
              IO.puts("  ✓ hello.txt content: #{String.trim(content)}")
            {:error, reason} ->
              IO.puts("  ✗ hello.txt not found: #{inspect(reason)}")
          end

          # Step 4: Update to completed
          IO.puts("\n=== Step 4: Mark task → Resolved + metadata ===")

          metadata = %{
            state: "Resolved"
          }

          case Adapter.update_record_with_metadata(record_id, metadata) do
            :ok ->
              IO.puts("✓ Task marked as 已完成")
            {:error, reason} ->
              IO.puts("✗ Failed to update: #{inspect(reason)}")
          end

          IO.puts("\n=== E2E Test Complete ===")
          IO.puts("Check the Bitable: https://qcnh0bjty8ev.feishu.cn/base/Ir7pbRChgaYRYns4hmWcNfHJnKe")

        {:error, reason} ->
          IO.puts("✗ Failed to claim task: #{inspect(reason)}")
      end
    else
      IO.puts("✗ Target task #{record_id} not found in candidates")
    end

  {:error, reason} ->
    IO.puts("✗ Failed to fetch candidates: #{inspect(reason)}")
    IO.puts("  Make sure FEISHU_APP_ID and FEISHU_APP_SECRET are set")
end
