defmodule SymphonyElixir.Git do
  @moduledoc """
  Git operations for Symphony task lifecycle.

  Handles branch creation and Merge Request creation in agent workspaces.
  In worktree mode, branch creation is skipped since the branch is created
  during `git worktree add`.
  """

  require Logger

  @spec create_branch(Path.t(), String.t()) :: {:ok, String.t()} | {:error, term()}
  def create_branch(workspace_path, issue_identifier) when is_binary(workspace_path) and is_binary(issue_identifier) do
    branch_name = branch_name_for_issue(issue_identifier)

    with :ok <- ensure_git_repo(workspace_path),
         :ok <- checkout_base_branch(workspace_path),
         :ok <- create_and_checkout_branch(workspace_path, branch_name) do
      Logger.info("Created branch for issue: branch=#{branch_name} workspace=#{workspace_path}")
      {:ok, branch_name}
    end
  end

  @spec create_merge_request(Path.t(), String.t(), String.t(), keyword()) ::
          {:ok, String.t()} | {:error, term()}
  def create_merge_request(workspace_path, issue_identifier, title, opts \\ [])
      when is_binary(workspace_path) and is_binary(issue_identifier) and is_binary(title) do
    branch_name = Keyword.get(opts, :branch_name, branch_name_for_issue(issue_identifier))
    body = Keyword.get(opts, :body, "Automated MR for #{issue_identifier}")
    base = Keyword.get(opts, :base, "main")

    # Check if there are commits on this branch vs base
    case has_diverged_commits?(workspace_path, base, branch_name) do
      true ->
        args = [
          "pr",
          "create",
          "--title",
          title,
          "--body",
          body,
          "--head",
          branch_name,
          "--base",
          base,
          "--json",
          "url"
        ]

        case System.cmd("gh", args, cd: workspace_path, stderr_to_stdout: true) do
          {output, 0} ->
            url = parse_gh_pr_url(output)
            Logger.info("Created MR for #{issue_identifier}: #{url}")
            {:ok, url}

          {output, status} ->
            # PR might already exist — try to get existing PR URL
            case get_existing_pr_url(workspace_path, branch_name) do
              {:ok, url} ->
                Logger.info("PR already exists for #{issue_identifier}: #{url}")
                {:ok, url}

              :error ->
                Logger.warning("Failed to create MR for #{issue_identifier}: status=#{status} output=#{String.slice(output, 0, 200)}")
                {:error, {:mr_creation_failed, status, output}}
            end
        end

      false ->
        Logger.info("No commits to create MR for #{issue_identifier}")
        {:error, :no_commits}

      :error ->
        # If we can't determine, try anyway
        Logger.warning("Could not determine commit status for #{issue_identifier}; attempting MR creation")

        args = [
          "pr",
          "create",
          "--title",
          title,
          "--body",
          body,
          "--head",
          branch_name,
          "--base",
          base,
          "--json",
          "url"
        ]

        case System.cmd("gh", args, cd: workspace_path, stderr_to_stdout: true) do
          {output, 0} ->
            {:ok, parse_gh_pr_url(output)}

          {output, status} ->
            Logger.warning("MR creation failed for #{issue_identifier}: status=#{status} output=#{String.slice(output, 0, 200)}")
            {:error, {:mr_creation_failed, status, output}}
        end
    end
  end

  @spec branch_name_for_issue(String.t()) :: String.t()
  def branch_name_for_issue(issue_identifier) when is_binary(issue_identifier) do
    safe =
      issue_identifier
      |> String.downcase()
      |> String.replace(~r/[^a-z0-9._-]+/, "-", global: true)
      |> String.trim("-")

    "symphony/#{safe}"
  end

  # --- Private helpers ---

  defp ensure_git_repo(workspace_path) do
    case System.cmd("git", ["rev-parse", "--is-inside-work-tree"], cd: workspace_path, stderr_to_stdout: true) do
      {"true", 0} ->
        :ok

      _ ->
        # Not a git repo (and not a worktree) — initialize one
        case System.cmd("git", ["init"], cd: workspace_path, stderr_to_stdout: true) do
          {_, 0} ->
            Logger.info("Initialized git repo in workspace=#{workspace_path}")
            :ok

          {output, status} ->
            Logger.warning("Failed to init git repo: status=#{status} output=#{String.slice(output, 0, 200)}")
            {:error, {:git_init_failed, status}}
        end
    end
  end

  defp checkout_base_branch(workspace_path) do
    # In worktree mode, the workspace is already on a symphony/* branch — skip checkout
    case System.cmd("git", ["branch", "--show-current"], cd: workspace_path, stderr_to_stdout: true) do
      {"symphony/" <> _, 0} ->
        :ok

      _ ->
        checkout_main_or_master(workspace_path)
    end
  end

  defp checkout_main_or_master(workspace_path) do
    case System.cmd("git", ["checkout", "main"], cd: workspace_path, stderr_to_stdout: true) do
      {_, 0} ->
        System.cmd("git", ["pull", "--ff-only"], cd: workspace_path, stderr_to_stdout: true)
        :ok

      _ ->
        case System.cmd("git", ["checkout", "master"], cd: workspace_path, stderr_to_stdout: true) do
          {_, 0} ->
            System.cmd("git", ["pull", "--ff-only"], cd: workspace_path, stderr_to_stdout: true)
            :ok

          _ ->
            # No main/master — just stay on current branch
            Logger.debug("No main/master branch found; using current branch as base")
            :ok
        end
    end
  end

  defp create_and_checkout_branch(workspace_path, branch_name) do
    # In worktree mode, already on the correct branch — skip
    case System.cmd("git", ["branch", "--show-current"], cd: workspace_path, stderr_to_stdout: true) do
      {current, 0} ->
        if String.trim(current) == branch_name do
          :ok
        else
          do_create_and_checkout_branch(workspace_path, branch_name)
        end

      _ ->
        do_create_and_checkout_branch(workspace_path, branch_name)
    end
  end

  defp do_create_and_checkout_branch(workspace_path, branch_name) do
    case System.cmd("git", ["checkout", "-b", branch_name], cd: workspace_path, stderr_to_stdout: true) do
      {_, 0} ->
        :ok

      {output, _} ->
        # Branch might already exist — just checkout
        case System.cmd("git", ["checkout", branch_name], cd: workspace_path, stderr_to_stdout: true) do
          {_, 0} ->
            :ok

          {output2, status} ->
            Logger.warning("Failed to create/checkout branch=#{branch_name}: status=#{status} output=#{String.slice(output <> output2, 0, 200)}")
            {:error, {:branch_checkout_failed, branch_name, status}}
        end
    end
  end

  defp has_diverged_commits?(workspace_path, base, branch) do
    # Check if branch has commits that base doesn't
    case System.cmd("git", ["log", "#{base}..#{branch}", "--oneline"], cd: workspace_path, stderr_to_stdout: true) do
      {output, 0} ->
        output = String.trim(output)
        output != ""

      _ ->
        # Fallback: check if branch differs from HEAD
        case System.cmd("git", ["log", "--oneline", "-1"], cd: workspace_path, stderr_to_stdout: true) do
          {output, 0} -> String.trim(output) != ""
          _ -> :error
        end
    end
  end

  defp get_existing_pr_url(workspace_path, branch_name) do
    case System.cmd("gh", ["pr", "view", branch_name, "--json", "url", "-q", ".url"],
           cd: workspace_path,
           stderr_to_stdout: true
         ) do
      {url, 0} ->
        url = String.trim(url)
        if url != "", do: {:ok, url}, else: :error

      _ ->
        :error
    end
  end

  defp parse_gh_pr_url(output) when is_binary(output) do
    case Jason.decode(output) do
      {:ok, %{"url" => url}} -> url
      _ -> String.trim(output)
    end
  end
end
