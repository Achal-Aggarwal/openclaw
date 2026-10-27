import {
  accessSidebarSnapshot,
  sidebarRecordBytes,
  type SidebarRecord,
} from "./session-sidebar-snapshot.ts";
import { debugSnapshotStore } from "./session-snapshot-database.ts";
import {
  sidebarSnapshotInvalidationMatches,
  subscribeSnapshotInvalidation,
  type SnapshotInvalidation,
} from "./session-snapshot-invalidation-events.ts";
import { deleteStoredChatSnapshot } from "./session-snapshot-invalidation.ts";
import { captureSnapshotReadScope } from "./session-snapshot-read-scope.ts";

const activeStores = new Set<SidebarSnapshotStore>();

/** Sidebar persistence shares the database, without loading the transcript codec. */
export class SidebarSnapshotStore {
  private connected = false;
  private readonly readScopes = new Map<string, { readers: number }>();
  private writeChain = Promise.resolve();

  connect(): void {
    this.connected = true;
    activeStores.add(this);
  }

  disconnect(): void {
    this.connected = false;
    this.forget({});
    void this.writeChain.finally(() => {
      if (!this.connected) {
        activeStores.delete(this);
      }
    });
  }

  async readSidebar<Model>(
    key: string,
    validate: (value: unknown) => Model | null,
  ): Promise<Model | null> {
    if (!this.connected) {
      return null;
    }
    const scope = captureSnapshotReadScope(this.readScopes, key);
    try {
      await this.writeChain;
      return await accessSidebarSnapshot(key, validate, () => this.connected && scope.isCurrent());
    } finally {
      scope.dispose();
    }
  }

  async writeSidebar<Model>(
    key: string,
    model: Model,
    validate: (value: unknown) => Model | null,
  ): Promise<boolean> {
    if (!this.connected || !key.startsWith("scope:[") || !key.includes("\u0000sidebar:")) {
      return false;
    }
    const scope = captureSnapshotReadScope(this.readScopes, key);
    try {
      const record: SidebarRecord = {
        sessionKey: key,
        savedAt: Date.now(),
        projectionVersion: 3,
        model: structuredClone(model),
      };
      if (sidebarRecordBytes(record) > 512 * 1024) {
        return false;
      }
      let written = false;
      this.writeChain = this.writeChain.then(async () => {
        written =
          (await accessSidebarSnapshot(
            key,
            validate,
            () => this.connected && scope.isCurrent(),
            record,
          )) !== null;
      });
      await this.writeChain;
      return written;
    } catch (error) {
      debugSnapshotStore("sidebar projection could not be cached", error);
      return false;
    } finally {
      scope.dispose();
    }
  }

  async delete(sessionKey: string): Promise<void> {
    this.readScopes.delete(sessionKey);
    await deleteStoredChatSnapshot(sessionKey);
  }

  forget(invalidation: SnapshotInvalidation): void {
    for (const key of this.readScopes.keys()) {
      if (key.includes("\u0000sidebar:") && sidebarSnapshotInvalidationMatches(key, invalidation)) {
        this.readScopes.delete(key);
      }
    }
  }

  async whenIdle(): Promise<void> {
    await this.writeChain;
  }
}

subscribeSnapshotInvalidation(async (invalidation) => {
  for (const store of activeStores) {
    store.forget(invalidation);
  }
  await Promise.all([...activeStores].map((store) => store.whenIdle()));
});
