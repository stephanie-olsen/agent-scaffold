# AI Agent Scaffolding Work

This repo contains work towards improving and augmenting an OpenClaw agent's behavior through scaffolding. 

## Context Folding

**Problem**: Default OpenClaw compaction used the same model as the agent (in this case, Opus 4.6), was very slow (sometimes >2min), resulted in poor compression rates, and was lossy.

**Method**: Ran systematic comparison of compaction strategies for long LLM conversations. Created evaluation metholodogy, tested 10 strategies across multiple context token thresholds (65k/80k/100k), retained-tail token sizes (10k/20k/30k), and models (Sonnet, Haiku, Grok 4.1 Fast, Gemini 3 Flash) with 3 replicas each.

**Results**: Haiku with modified folding (topic segmentation + summary) significantly outperformed default Opus compaction in cost (18x), compression (2x), time elapsed (4x), and quality (1.25x). Implemented this method in local fork.

**Code**: See [agent-scaffolding/context-folding](https://github.com/stephanie-olsen/agent-scaffold/tree/main/context-folding).


## Graph-Based Memory System

**Problem**: Agents lose all context between sessions. Existing OpenClaw memory system (flat .md files) doesn't scale, and even using vector embedding retrieval lacks structure — they find similar text but not related concepts.

**Method**: Built an embedded graph memory system with 12 node types (i.e. `held-contradiction`, `behavioral-principle`, `impression`) and 19 edge types (i.e. `tension_with`, `exemplifies`, `resolved_from`). Nodes have trust levels, decay rates, access tracking, and Gemini embeddings. Retrieval uses a hybrid scoring function (semantic / keyword / graph traversal) with spreading activation across edges. RAG system injects graph nodes into context based on conversation history; agent also searches graph for knowledge during conversation.

**Results**: Agent displays improved persistent identity, preferences, and working knowledge across sessions with less manual context management. Graph structure enables retrieval that vector similarity alone misses, like surfacing a contradiction relevant to a current claim or a decision's downstream consequences. Currently managing 8,000+ nodes.

**Code**: See [agent-scaffold/graph-memory](https://github.com/stephanie-olsen/agent-scaffold/tree/main/graph-memory).


## Experiment Pipeline

**Problem**: Ad-hoc LLM experiments aren't reproducible. No protocol documentation, pilot data mixed with study data, no stopping criteria. Highly susceptible to confirmation bias.

**Method**: Designed a pipeline separating experiment design (which is judgment-heavy) from execution (which is mechanical). Pipeline enforces written protocol guidelines, pilot/study data separation, pre-registered hypotheses, elimination criteria, and cost budgets with checkpoints. Methods standard (METHODS.md) draws from Shadish, Cook & Campbell's validity framework — every protocol must identify its design type and address threats to statistical conclusion, internal, construct, and external validity.

**Results**: 113+ experiments registered, spanning LLM attractor dynamics, context folding, identity perturbation, and measurement methodology. Pipeline catches methodology errors early before the main study runs.

**Code**: See [agent-scaffold/experiment-pipeline](https://github.com/stephanie-olsen/agent-scaffold/tree/main/experiment-pipeline).
