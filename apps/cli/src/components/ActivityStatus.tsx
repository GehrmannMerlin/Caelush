import { Text } from "ink";
import type { SubmissionSkillPreparationV1 } from "@caelush/protocol";
import type { CliActivity, CliSkillRunStatus } from "../application/cli-state.js";

export function ActivityStatus({
  activity,
  skillPreparation,
  skillRunStatuses,
  skillPreparationWarning,
}: {
  readonly activity: CliActivity;
  readonly skillPreparation?: SubmissionSkillPreparationV1 | undefined;
  readonly skillRunStatuses?: readonly CliSkillRunStatus[] | undefined;
  readonly skillPreparationWarning?: string | undefined;
}) {
  const skillNames = skillPreparation?.selectedSkills.map(
    (skill) => skill.displayName ?? skill.name,
  );
  const skillStatusLabels: Record<CliSkillRunStatus["status"], string> = {
    READING: "正在读取",
    CONTENT_READY: "正文已准备，尚未确认载入",
    LOADED: "已加入上下文",
    FAILED: "读取失败",
  };
  return (
    <>
      <Text color={activity === "Transport error" || activity === "Cancelling" ? "yellow" : "gray"}>
        Status: {activity}
      </Text>
      {skillRunStatuses?.map((skill) => (
        <Text
          key={skill.skillId}
          color={
            skill.status === "FAILED" ? "yellow" : skill.status === "LOADED" ? "green" : "cyan"
          }
        >
          Skill {skillStatusLabels[skill.status]}：{skill.name}
        </Text>
      ))}
      {skillRunStatuses === undefined &&
      skillPreparation?.preparationStatus === "CONTENT_READY" &&
      skillNames !== undefined ? (
        <Text color="cyan">Skill 正文已准备，尚未确认读取：{skillNames.join("、")}</Text>
      ) : null}
      {skillPreparationWarning === undefined ? null : (
        <Text color="yellow">{skillPreparationWarning}</Text>
      )}
    </>
  );
}
