import type { ReactElement } from "react";
import type { SkillCatalogItemV1 } from "@caelush/protocol";

export interface SelectedSkillListProps {
  readonly skills: readonly SkillCatalogItemV1[];
  readonly onRemove: (skillId: string) => void;
}

export function SelectedSkillList(props: SelectedSkillListProps): ReactElement | null {
  if (props.skills.length === 0) return null;
  return (
    <ul className="selected-skill-list" aria-label="已选技能">
      {props.skills.map((skill) => {
        const label = skill.displayName ?? skill.name;
        return (
          <li className="selected-skill-tag" key={skill.skillId}>
            <span className="selected-skill-tag-name">{label}</span>
            <button
              type="button"
              className="selected-skill-tag-remove"
              aria-label={`移除技能 ${label}`}
              onClick={() => props.onRemove(skill.skillId)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
