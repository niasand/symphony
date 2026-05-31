defmodule SymphonyElixir.ComplexityClassifier do
  @moduledoc """
  Pure-function classifier that determines whether an issue should be
  decomposed into sub-tasks or handled by a single agent.

  Classification is deliberately cheap: no LLM calls, no I/O — just
  string matching on labels, description length, and keywords.
  """

  alias SymphonyElixir.Config.Schema.Decomposition
  alias SymphonyElixir.Tracker.Issue

  @spec classify(Issue.t(), Decomposition.t()) :: :simple | :complex
  def classify(%Issue{} = issue, %Decomposition{} = config) do
    cond do
      # Feature disabled — everything is simple
      not config.enabled ->
        :simple

      # Sub-tasks are always simple (never decompose a decomposition)
      issue.parent_id != nil ->
        :simple

      # Label-based detection
      has_complex_label?(issue.labels, config.complexity_keywords) ->
        :complex

      # Description length threshold
      description_exceeds_threshold?(issue.description, config.description_length_threshold) ->
        :complex

      true ->
        :simple
    end
  end

  defp has_complex_label?(labels, keywords) when is_list(labels) and is_list(keywords) do
    normalized_keywords = Enum.map(keywords, &normalize_keyword/1)

    Enum.any?(labels, fn label ->
      normalize_keyword(label) in normalized_keywords
    end)
  end

  defp has_complex_label?(_labels, _keywords), do: false

  defp description_exceeds_threshold?(description, threshold)
       when is_binary(description) and is_integer(threshold) and threshold > 0 do
    byte_size(description) > threshold
  end

  defp description_exceeds_threshold?(_description, _threshold), do: false

  defp normalize_keyword(keyword) when is_binary(keyword) do
    keyword |> String.trim() |> String.downcase()
  end

  defp normalize_keyword(_), do: ""
end
