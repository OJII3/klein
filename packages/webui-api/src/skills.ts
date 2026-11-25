export type SkillRequirement = "browser" | "coding";

export interface SkillFileSummary {
  readonly path: string;
  readonly size: number;
}

export interface SkillAvailability {
  readonly conversation: boolean;
  readonly ownerWorker: boolean;
  readonly linkedUserWorker: boolean;
}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly files: readonly SkillFileSummary[];
  readonly modelInvocable: boolean;
  readonly requirements: readonly SkillRequirement[];
  readonly availability: SkillAvailability;
  readonly promptEntry: string | null;
}

export interface SkillDiagnostic {
  readonly type: "warning" | "error";
  readonly message: string;
  readonly path?: string;
}

export interface SkillsReport {
  readonly profile: string;
  readonly directory: string;
  readonly directoryExists: boolean;
  readonly skills: readonly SkillSummary[];
  readonly diagnostics: readonly SkillDiagnostic[];
}

export interface SkillFileContent {
  readonly path: string;
  readonly content: string;
}

export interface SkillReader {
  list(): Promise<SkillsReport>;
  readFile(skillName: string, path: string): Promise<SkillFileContent | undefined>;
}
