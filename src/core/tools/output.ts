export type ToolOutputTruncation = {
  omittedChars: number;
  text: string;
  totalChars: number;
  truncated: boolean;
};

/**
 * Clips tool output for the transcript, leaving a marker the model can act on.
 *
 * A bare "[truncated]" tells the model that something is missing but not how to
 * get it, so it either gives up or re-runs the whole command. The marker below
 * names the exact follow-up call and the on-disk artifact instead.
 */
export function truncateToolOutput(params: {
  artifactPath?: string;
  content: string;
  followUp?: string;
  maxChars: number;
}): ToolOutputTruncation {
  const totalChars = params.content.length;
  if (totalChars <= params.maxChars) {
    return {
      omittedChars: 0,
      text: params.content,
      totalChars,
      truncated: false
    };
  }

  const shown = params.content.slice(0, params.maxChars);
  const omittedChars = totalChars - shown.length;
  const directions = [
    `${omittedChars.toLocaleString("en-US")} of ${totalChars.toLocaleString("en-US")} characters omitted`,
    params.followUp ? `read the rest with ${params.followUp}` : undefined,
    params.artifactPath ? `full output: ${params.artifactPath}` : undefined
  ].filter((part): part is string => part !== undefined);

  return {
    omittedChars,
    text: `${shown}\n\n[output truncated: ${directions.join("; ")}]`,
    totalChars,
    truncated: true
  };
}
