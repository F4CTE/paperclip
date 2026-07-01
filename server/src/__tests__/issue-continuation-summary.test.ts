import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS,
  buildContinuationSummaryMarkdown,
  continuationSummaryParksExecutor,
  extractContinuationSummaryNextAction,
  getIssueContinuationSummaryDocument,
  refreshIssueContinuationSummary,
} from "../services/issue-continuation-summary.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("issue continuation summaries", () => {
  it("builds bounded issue-local handoff context with required sections", () => {
    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1579",
        title: "Add continuation summaries",
        description: [
          "## Objective",
          "",
          "Keep work resumable after adapter session reset.",
          "",
          "## Acceptance Criteria",
          "",
          "- Summary is issue-local",
          "- Wake context includes the summary",
        ].join("\n"),
        status: "in_progress",
        priority: "medium",
      },
      run: {
        id: "run-1",
        status: "succeeded",
        error: null,
        resultJson: {
          summary: "Updated server/src/services/heartbeat.ts and packages/adapter-utils/src/server-utils.ts.",
        },
        stdoutExcerpt: null,
        stderrExcerpt: null,
        finishedAt: new Date("2026-04-18T12:00:00.000Z"),
      },
      agent: {
        id: "agent-1",
        name: "CodexCoder",
        adapterType: "codex_local",
      },
    });

    expect(body).toContain("# Continuation Summary");
    expect(body).toContain("## Objective");
    expect(body).toContain("Keep work resumable after adapter session reset.");
    expect(body).toContain("## Acceptance Criteria");
    expect(body).toContain("- Summary is issue-local");
    expect(body).toContain("## Recent Concrete Actions");
    expect(body).toContain("Run `run-1` finished with status `succeeded`");
    expect(body).toContain("`server/src/services/heartbeat.ts`");
    expect(body).toContain("## Commands Run");
    expect(body).toContain("## Blockers / Decisions");
    expect(body).toContain("## Next Action");
    expect(body.length).toBeLessThanOrEqual(ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS);
  });

  it("uses failure state to point the next run at the error", () => {
    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1579",
        title: "Add continuation summaries",
        description: null,
        status: "in_progress",
        priority: "medium",
      },
      run: {
        id: "run-2",
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        resultJson: null,
      },
      agent: {
        id: "agent-1",
        name: "CodexCoder",
        adapterType: "codex_local",
      },
    });

    expect(body).toContain("Latest run error (adapter_failed): adapter failed");
    expect(body).toContain("Inspect the failed run, fix the cause");
  });

  it("detects continuation summaries that explicitly park executor work for review", () => {
    const body = [
      "# Continuation Summary",
      "",
      "## Next Action",
      "",
      "- Wait for reviewer feedback or approval before continuing executor work.",
    ].join("\n");

    expect(extractContinuationSummaryNextAction(body)).toBe(
      "Wait for reviewer feedback or approval before continuing executor work.",
    );
    expect(continuationSummaryParksExecutor(body)).toBe(true);
  });

  it("does not park executor work when the next action is still runnable", () => {
    const body = [
      "# Continuation Summary",
      "",
      "## Next Action",
      "",
      "- Re-check run `25145432006`, then move the issue to `in_review` if the final step is green.",
    ].join("\n");

    expect(continuationSummaryParksExecutor(body)).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue continuation summaries persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-continuation-summary-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(heartbeatRuns);
    await db.delete(documents);
    await db.delete(agents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("retries when concurrent first writes race on the continuation summary key", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-2001",
      title: "Concurrent continuation summary refresh",
      description: "Reproduce the continuation summary create race.",
      status: "in_progress",
      priority: "medium",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "Engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      {
        id: firstRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        contextSnapshot: { issueId },
      },
      {
        id: secondRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        contextSnapshot: { issueId },
      },
    ]);

    const baseInput = {
      db,
      issueId,
      agent: {
        id: agentId,
        name: "CodexCoder",
        adapterType: "codex_local",
      },
    } as const;

    const [first, second] = await Promise.all([
      refreshIssueContinuationSummary({
        ...baseInput,
        run: {
          id: firstRunId,
          status: "succeeded",
          error: null,
          resultJson: { summary: "First refresh" },
        },
      }),
      refreshIssueContinuationSummary({
        ...baseInput,
        run: {
          id: secondRunId,
          status: "succeeded",
          error: null,
          resultJson: { summary: "Second refresh" },
        },
      }),
    ]);

    const persisted = await getIssueContinuationSummaryDocument(db, issueId);
    const documentRows = await db.select().from(documents);
    const issueDocumentRows = await db.select().from(issueDocuments);
    const revisionRows = await db.select().from(documentRevisions);

    expect(first?.key).toBe("continuation-summary");
    expect(second?.key).toBe("continuation-summary");
    expect(persisted).toEqual(expect.objectContaining({
      key: "continuation-summary",
      latestRevisionNumber: 2,
    }));
    expect(documentRows).toHaveLength(1);
    expect(issueDocumentRows).toHaveLength(1);
    expect(revisionRows).toHaveLength(2);
  });
});
