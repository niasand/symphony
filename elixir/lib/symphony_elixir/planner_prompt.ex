defmodule SymphonyElixir.PlannerPrompt do
  @moduledoc """
  Builds specialized prompts for the planner and merge agents used in
  task decomposition.
  """

  alias SymphonyElixir.Config.Schema.Decomposition
  alias SymphonyElixir.Tracker.Issue

  @decomposition_output_path ".symphony/decomposition.json"

  @spec decomposition_output_path() :: String.t()
  def decomposition_output_path, do: @decomposition_output_path

  @spec build_planner_prompt(Issue.t(), Decomposition.t()) :: String.t()
  def build_planner_prompt(%Issue{} = issue, %Decomposition{} = config) do
    """
    You are a task planner. Analyze the following task and decompose it into independent sub-tasks that can be executed in parallel by separate coding agents.

    ## Original Task

    **Title**: #{issue.title || "Untitled"}

    **Description**:
    #{issue.description || "No description provided."}

    ## Your Mission

    1. Read and understand the full scope of this task.
    2. Break it down into **2 to #{config.max_sub_tasks}** independent sub-tasks.
    3. Each sub-task should be self-contained and executable by a single coding agent.
    4. Sub-tasks should not overlap in scope — they must not modify the same files.
    5. Order sub-tasks by logical priority (foundation first, integration last).

    ## Output Format

    Write a JSON file to `#{@decomposition_output_path}` in the workspace root with this exact structure:

    ```json
    {
      "sub_tasks": [
        {
          "title": "Short descriptive title",
          "description": "Detailed description of what this sub-task should accomplish. Include specific files, functions, or modules to modify.",
          "scope": "Brief note on which files/areas this sub-task touches"
        }
      ]
    }
    ```

    ## Rules

    - Produce **at least 2** and **at most #{config.max_sub_tasks}** sub-tasks.
    - Each sub-task must have a clear, independent scope.
    - If the task is genuinely simple and cannot be decomposed, output an empty sub_tasks array: `{"sub_tasks": []}` — the orchestrator will handle it as a single task instead.
    - Be specific: mention file names, module names, function signatures where possible.
    - Sub-tasks should produce code that integrates without conflicts.

    Proceed with analysis and write the decomposition file.
    """
  end

  @spec build_merge_prompt(Issue.t(), [Issue.t()]) :: String.t()
  def build_merge_prompt(%Issue{} = parent, sub_tasks) when is_list(sub_tasks) do
    sub_task_summaries =
      sub_tasks
      |> Enum.with_index(1)
      |> Enum.map(fn {task, idx} ->
        """
        ### Sub-task #{idx}: #{task.title || "Untitled"}
        #{task.description || "No description."}
        """
      end)
      |> Enum.join("\n")

    """
    You are an integration agent. All sub-tasks of a decomposed task have completed. Your job is to verify the integration and ensure the full task is properly resolved.

    ## Original Task

    **Title**: #{parent.title || "Untitled"}

    **Description**:
    #{parent.description || "No description provided."}

    ## Completed Sub-tasks

    #{sub_task_summaries}

    ## Your Mission

    1. Review the workspace state after all sub-tasks have executed.
    2. Verify that sub-task results integrate correctly (no import errors, no conflicting changes).
    3. Run any available tests or lint checks to validate the integration.
    4. Fix any integration issues you find (merge conflicts, missing imports, broken tests).
    5. If everything looks good, no further action is needed.

    ## Rules

    - Focus on integration correctness, not re-implementing sub-task work.
    - If a sub-task clearly failed or produced broken code, fix it.
    - Do not add features beyond the original task scope.
    """
  end
end
