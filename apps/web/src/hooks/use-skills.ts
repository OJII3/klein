import { useCallback, useEffect, useState } from "preact/hooks";

import { getSkillFile, getSkills, type SkillFileContent, type SkillsReport } from "../api";

const DEFAULT_SKILL_FILE = "SKILL.md";

interface UseSkillsOptions {
  active: boolean;
  onUpdated: () => void;
  selectedSkillName: string | null;
}

interface FileSelection {
  readonly skillName: string;
  readonly path: string;
}

interface FileResult extends FileSelection {
  readonly content: SkillFileContent;
}

interface FileFailure extends FileSelection {
  readonly message: string;
}

export function useSkills({ active, onUpdated, selectedSkillName }: UseSkillsOptions) {
  const [report, setReport] = useState<SkillsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileSelection, setFileSelection] = useState<FileSelection | null>(null);
  const [fileResult, setFileResult] = useState<FileResult | null>(null);
  const [fileFailure, setFileFailure] = useState<FileFailure | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileReloadKey, setFileReloadKey] = useState(0);

  const selectedSkill = report?.skills.find((skill) => skill.name === selectedSkillName) ?? null;
  const defaultPath = selectedSkill?.files[0]?.path ?? DEFAULT_SKILL_FILE;
  const selectedPath =
    selectedSkill && fileSelection?.skillName === selectedSkill.name
      ? fileSelection.path
      : defaultPath;
  const fileContent =
    fileResult && fileResult.skillName === selectedSkill?.name && fileResult.path === selectedPath
      ? fileResult.content
      : null;
  const fileError =
    fileFailure &&
    fileFailure.skillName === selectedSkill?.name &&
    fileFailure.path === selectedPath
      ? fileFailure.message
      : null;

  const load = useCallback(async () => {
    setError(null);
    try {
      setReport(await getSkills());
      onUpdated();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to load skills");
    }
  }, [onUpdated]);

  useEffect(() => {
    if (!active) return undefined;
    void load();
    return undefined;
  }, [active, load]);

  useEffect(() => {
    setFileSelection(null);
    setFileResult(null);
    setFileFailure(null);
  }, [selectedSkillName]);

  useEffect(() => {
    if (!active || !selectedSkill) {
      setFileLoading(false);
      return undefined;
    }

    const skillName = selectedSkill.name;
    const path = selectedPath;
    let current = true;
    setFileLoading(true);

    void (async () => {
      try {
        const content = await getSkillFile(skillName, path);
        if (!current) return;
        setFileResult({ skillName, path, content });
        setFileFailure(null);
      } catch (requestError) {
        if (!current) return;
        setFileResult(null);
        setFileFailure({
          skillName,
          path,
          message:
            requestError instanceof Error ? requestError.message : "Failed to load skill file",
        });
      } finally {
        if (current) setFileLoading(false);
      }
    })();

    return () => {
      current = false;
    };
  }, [active, fileReloadKey, selectedPath, selectedSkill]);

  const selectFile = useCallback(
    (path: string) => {
      if (!selectedSkill) return;
      setFileSelection({ skillName: selectedSkill.name, path });
    },
    [selectedSkill],
  );

  const retryFile = useCallback(() => {
    setFileReloadKey((key) => key + 1);
  }, []);

  return {
    error,
    fileContent,
    fileError,
    fileLoading,
    reload: load,
    report,
    retryFile,
    selectedPath,
    selectedSkill,
    selectFile,
  };
}
