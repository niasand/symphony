defmodule SymphonyElixir.TaskDecomposer do
  @moduledoc """
  Reads planner agent output, creates sub-task tracker records, and
  detects when all children of a parent issue are complete.
  """

  require Logger

  alias SymphonyElixir.{Config, PlannerPrompt, Tracker}
  alias SymphonyElixir.Tracker.Issue

  @type sub_task_def :: %{
          title: String.t(),
          description: String.t(),
          scope: String.t()
        }

  @spec read_decomposition(Path.t()) :: {:ok, [sub_task_def()]} | {:error, term()}
  def read_decomposition(workspace_path) when is_binary(workspace_path) do
    path = Path.join(workspace_path, PlannerPrompt.decomposition_output_path())

    case File.read(path) do
      {:ok, content} ->
        parse_decomposition(content)

      {:error, reason} ->
        Logger.warning("Decomposition file not found at #{path}: #{inspect(reason)}")
        {:error, {:decomposition_file_missing, reason}}
    end
  end

  @spec create_sub_tasks(Issue.t(), [sub_task_def()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def create_sub_tasks(%Issue{id: parent_id, identifier: parent_identifier}, sub_task_defs)
      when is_binary(parent_id) and is_list(sub_task_defs) do
    config = Config.settings!().decomposition

    results =
      sub_task_defs
      |> Enum.take(config.max_sub_tasks)
      |> Enum.with_index(1)
      |> Enum.map(fn {defn, idx} ->
        attrs = %{
          title: defn[:title] || defn["title"] || "Sub-task #{idx}",
          description:
            build_sub_task_description(
              defn[:description] || defn["description"],
              defn[:scope] || defn["scope"]
            ),
          state: "Open",
          parent_id: parent_id,
          labels: ["sub-task"],
          priority: 2
        }

        case Tracker.create_issue(attrs) do
          {:ok, issue} ->
            Logger.info(
              "Created sub-task #{idx} for parent=#{parent_identifier || parent_id}: " <>
                "issue_id=#{issue.id} title=#{issue.title}"
            )

            {:ok, issue}

          {:error, reason} ->
            Logger.warning("Failed to create sub-task #{idx} for parent=#{parent_identifier || parent_id}: #{inspect(reason)}")

            {:error, reason}
        end
      end)

    successes = Enum.filter(results, &match?({:ok, _}, &1))

    if length(successes) > 0 do
      {:ok, Enum.map(successes, fn {:ok, issue} -> issue end)}
    else
      {:error, :all_sub_task_creations_failed}
    end
  end

  @spec all_children_terminal?([String.t()], %{String.t() => map()}) :: boolean()
  def all_children_terminal?(child_ids, running) when is_list(child_ids) and is_map(running) do
    Enum.all?(child_ids, fn child_id ->
      # Not in running map means it has completed
      not Map.has_key?(running, child_id)
    end)
  end

  def all_children_terminal?(_child_ids, _running), do: false

  # --- Private ---

  defp parse_decomposition(content) when is_binary(content) do
    case Jason.decode(content) do
      {:ok, %{"sub_tasks" => sub_tasks}} when is_list(sub_tasks) ->
        {:ok, Enum.map(sub_tasks, &normalize_sub_task_def/1)}

      {:ok, other} ->
        Logger.warning("Unexpected decomposition JSON structure: #{inspect(other)}")
        {:error, {:invalid_decomposition_structure, other}}

      {:error, reason} ->
        Logger.warning("Failed to parse decomposition JSON: #{inspect(reason)}")
        {:error, {:decomposition_parse_error, reason}}
    end
  end

  defp normalize_sub_task_def(defn) when is_map(defn) do
    %{
      title: defn["title"] || "Untitled sub-task",
      description: defn["description"] || "",
      scope: defn["scope"] || ""
    }
  end

  defp normalize_sub_task_def(_), do: %{title: "Untitled sub-task", description: "", scope: ""}

  defp build_sub_task_description(description, scope) do
    parts = [
      "This is a sub-task of a larger decomposition.",
      "",
      description || ""
    ]

    parts =
      if scope && scope != "" do
        parts ++ ["", "Scope: #{scope}"]
      else
        parts
      end

    Enum.join(parts, "\n")
  end
end
