defmodule SymphonyElixir.ComplexityClassifierTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.ComplexityClassifier
  alias SymphonyElixir.Config.Schema.Decomposition
  alias SymphonyElixir.Tracker.Issue

  describe "classify/2" do
    test "returns :simple when decomposition is disabled" do
      issue = %Issue{labels: ["epic"], description: String.duplicate("x", 5000)}
      config = %Decomposition{enabled: false}

      assert :simple = ComplexityClassifier.classify(issue, config)
    end

    test "returns :simple when issue is a sub-task (has parent_id)" do
      issue = %Issue{parent_id: "parent-123", labels: ["epic"]}
      config = %Decomposition{enabled: true}

      assert :simple = ComplexityClassifier.classify(issue, config)
    end

    test "returns :complex when label matches complexity keyword" do
      issue = %Issue{labels: ["epic", "backend"]}
      config = %Decomposition{enabled: true}

      assert :complex = ComplexityClassifier.classify(issue, config)
    end

    test "returns :complex for label matching regardless of case" do
      issue = %Issue{labels: ["Epic", "Backend"]}
      config = %Decomposition{enabled: true}

      assert :complex = ComplexityClassifier.classify(issue, config)
    end

    test "returns :complex for refactor keyword" do
      issue = %Issue{labels: ["refactor"]}
      config = %Decomposition{enabled: true}

      assert :complex = ComplexityClassifier.classify(issue, config)
    end

    test "returns :complex when description exceeds threshold" do
      issue = %Issue{description: String.duplicate("x", 2001)}
      config = %Decomposition{enabled: true, description_length_threshold: 2000}

      assert :complex = ComplexityClassifier.classify(issue, config)
    end

    test "returns :simple when description is exactly at threshold" do
      issue = %Issue{description: String.duplicate("x", 2000)}
      config = %Decomposition{enabled: true, description_length_threshold: 2000}

      assert :simple = ComplexityClassifier.classify(issue, config)
    end

    test "returns :simple for a normal issue with no special signals" do
      issue = %Issue{labels: ["bug"], description: "Fix a typo in README"}
      config = %Decomposition{enabled: true}

      assert :simple = ComplexityClassifier.classify(issue, config)
    end

    test "returns :simple when description is nil" do
      issue = %Issue{description: nil, labels: []}
      config = %Decomposition{enabled: true}

      assert :simple = ComplexityClassifier.classify(issue, config)
    end
  end
end
