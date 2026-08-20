import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const preferredStrictSampling = { type: "json_schema", strict: "prefer" } as const;

const submitPlan = defineTool({
  name: "sab_submit_plan",
  label: "Submit managed plan",
  description: "Submit the final managed-run plan. This must be the planner's last action.",
  promptSnippet: "Submit the final plan as validated structured data",
  promptGuidelines: [
    "Use sab_submit_plan as your final action after repository investigation is complete.",
    "Do not print the plan as prose and do not continue after submitting it.",
  ],
  constrainedSampling: preferredStrictSampling,
  parameters: Type.Object({
    summary: Type.String({ minLength: 1, maxLength: 2000, description: "One-sentence plan summary" }),
    steps: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 2, maxItems: 24, description: "Concrete ordered implementation or investigation steps",
    }),
    risks: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      maxItems: 12, description: "Material risks or unknowns",
    }),
  }, { additionalProperties: false }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text" as const, text: `Submitted ${params.steps.length} managed plan steps.` }],
      details: {
        kind: "plan",
        summary: params.summary,
        steps: params.steps,
        risks: params.risks,
      },
      terminate: true,
    };
  },
});

const submitReview = defineTool({
  name: "sab_submit_review",
  label: "Submit managed review",
  description: "Submit the independent managed-run review. This must be the reviewer's last action.",
  promptSnippet: "Submit the final independent review as validated structured data",
  promptGuidelines: [
    "Use sab_submit_review as your final action after the independent review is complete.",
    "Use verdict fix only for concrete defects and do not continue after submitting it.",
  ],
  constrainedSampling: preferredStrictSampling,
  parameters: Type.Object({
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("fix")]),
    summary: Type.String({ minLength: 1, maxLength: 4000 }),
    findings: Type.Array(Type.String({ minLength: 1, maxLength: 1500 }), { maxItems: 20 }),
  }, { additionalProperties: false }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text" as const, text: `Submitted managed review verdict: ${params.verdict}.` }],
      details: {
        kind: "review",
        verdict: params.verdict,
        summary: params.summary,
        findings: params.findings,
      },
      terminate: true,
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(submitPlan);
  pi.registerTool(submitReview);
}
