import type {
  UserMemory,
  UserMemoryIdentity,
  UserMemoryPatch,
  UserMemorySummary,
} from "../domain/user-memory";

export interface UserMemoryStore {
  read(userId: string): Promise<UserMemory | undefined>;
  ensure(userId: string, identity: UserMemoryIdentity): Promise<UserMemory>;
  update(userId: string, identity: UserMemoryIdentity, patch: UserMemoryPatch): Promise<UserMemory>;
}

export interface UserMemoryReader {
  list(): Promise<readonly UserMemorySummary[]>;
  read(userId: string): Promise<UserMemory | undefined>;
}

export interface UserMemoryEditor {
  /** Removes the stored memory. Returns false when the user had no memory. */
  delete(userId: string): Promise<boolean>;
}
