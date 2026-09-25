/**
 * What signal 0 says about a pid.
 *
 * `not_ours` (EPERM) means some process holds the pid but belongs to another
 * user. Whether that counts as alive depends on the caller: a job this process
 * spawned may have changed credentials, but a record this user wrote can only
 * name someone else's process if its pid has since been reused.
 */
export type ProcessLiveness = "alive" | "dead" | "not_ours";

export function checkProcessLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? "not_ours" : "dead";
  }
}
