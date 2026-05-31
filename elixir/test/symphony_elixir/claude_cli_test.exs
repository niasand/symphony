defmodule SymphonyElixir.ClaudeCLITest do
  use SymphonyElixir.TestSupport

  test "runs a Claude Code turn and maps stream-json events" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-claude-cli-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-CLAUDE")
      claude_binary = Path.join(test_root, "fake-claude")
      trace_file = Path.join(test_root, "claude.trace")

      File.mkdir_p!(workspace)
      write_fake_claude!(claude_binary, trace_file)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "claude",
        claude_command: claude_binary,
        claude_model: "claude-test",
        claude_max_turns_per_invocation: 3,
        claude_skip_permissions: true,
        claude_system_prompt: "system guard"
      )

      issue = %Issue{
        id: "issue-claude",
        identifier: "MT-CLAUDE",
        title: "Run Claude",
        description: "Exercise Claude CLI adapter",
        state: "In Progress"
      }

      events = self()

      assert {:ok, result} =
               ClaudeCLI.run(workspace, "Fix the bug", issue, on_message: fn event -> send(events, {:claude_event, event}) end)

      assert result.session_id == "claude-session-1"

      assert_receive {:claude_event, %{event: :session_started, session_id: session_id}}, 500
      assert String.starts_with?(session_id, "claude-")

      assert_receive {:claude_event, %{event: :notification, message: "Working"}}, 500

      assert_receive {:claude_event,
                      %{
                        event: :turn_completed,
                        usage: %{input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0.05}
                      }},
                     500

      trace = File.read!(trace_file)
      assert trace =~ "--output-format stream-json"
      assert trace =~ "--model claude-test"
      assert trace =~ "--max-turns 3"
      assert trace =~ "--dangerously-skip-permissions"
      assert trace =~ "--system-prompt system guard"
      assert trace =~ "Fix the bug"
    after
      File.rm_rf(test_root)
    end
  end

  test "resumes the Claude conversation across continuation turns" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-claude-resume-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")
      claude_binary = Path.join(test_root, "fake-claude")
      trace_file = Path.join(test_root, "claude.trace")

      File.mkdir_p!(workspace_root)
      write_fake_claude!(claude_binary, trace_file)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        agent_kind: "claude",
        claude_command: claude_binary,
        max_turns: 2
      )

      parent = self()

      state_fetcher = fn [_issue_id] ->
        attempt = Process.get(:claude_state_fetch_count, 0) + 1
        Process.put(:claude_state_fetch_count, attempt)
        send(parent, {:issue_state_fetch, attempt})

        state = if attempt == 1, do: "In Progress", else: "Done"

        {:ok,
         [
           %Issue{
             id: "issue-claude-resume",
             identifier: "MT-CLAUDE-2",
             title: "Continue Claude",
             description: "Exercise resume",
             state: state
           }
         ]}
      end

      issue = %Issue{
        id: "issue-claude-resume",
        identifier: "MT-CLAUDE-2",
        title: "Continue Claude",
        description: "Exercise resume",
        state: "In Progress"
      }

      assert :ok = AgentRunner.run(issue, nil, issue_state_fetcher: state_fetcher)
      assert_receive {:issue_state_fetch, 1}
      assert_receive {:issue_state_fetch, 2}

      trace = File.read!(trace_file)
      assert length(Regex.scan(~r/^ARGS:/m, trace)) == 2
      assert trace =~ "--resume claude-session-1"
      assert trace =~ "Continuation guidance:"
    after
      File.rm_rf(test_root)
    end
  end

  defp write_fake_claude!(path, trace_file) do
    File.write!(path, """
    #!/bin/sh
    trace_file=#{shell_quote(trace_file)}
    printf 'ARGS:%s\\n' "$*" >> "$trace_file"

    if echo " $* " | grep -q -- ' --resume '; then
      session_id="claude-session-2"
    else
      session_id="claude-session-1"
    fi

    printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Working"}]}}'
    printf '{"type":"result","subtype":"success","result":"done","session_id":"%s","cost_usd":0.05,"duration_ms":1200}\\n' "$session_id"
    """)

    File.chmod!(path, 0o755)
  end

  defp shell_quote(value) do
    "'" <> String.replace(value, "'", "'\"'\"'") <> "'"
  end
end
