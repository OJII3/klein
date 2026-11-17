import type { UserMemory, UserMemoryMessage } from "../domain/user-memory";

export interface UserMemoryProcessor {
  process(
    userId: string,
    memory: UserMemory,
    messages: readonly UserMemoryMessage[],
  ): Promise<UserMemory | undefined>;
}
