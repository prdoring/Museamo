export interface TagSharing { collectionId: string; role: "owner" | "member"; status: "waiting" | "syncing" | "attachment-pending"; lastSync?: number | null }
export interface ShareMember { id: string; name: string; owner: boolean; you: boolean }
export interface TagShareState { collectionId: string | null; role?: TagSharing["role"]; status?: TagSharing["status"]; attachmentsPending?: number; lastSync?: number | null; lastError?: string | null; members?: ShareMember[] }
export interface TagInvitation { inviteId: string; expiresAt: number; invite: string; imageDataUrl: string }
export interface ShareBridge {
  getTagShareState(input: { tagId: string }): Promise<TagShareState>;
  startTagSharing(input: { tagId: string }): Promise<{ collectionId: string }>;
  createTagInvite(input: { tagId: string }): Promise<TagInvitation>;
  cancelTagInvite(input: { inviteId: string }): Promise<void>;
  scanTagInvite(): Promise<{ cancelled: boolean; invite?: string }>;
  previewTagInvite(input: { invite: string }): Promise<{ name: string; type: "standard" | "checklist"; count: number; expiresAt: number }>;
  joinTagShare(input: { invite: string }): Promise<{ tagId: string; collectionId: string }>;
  removeTagShareMember(input: { tagId: string; memberId: string }): Promise<void>;
  leaveTagShare(input: { tagId: string }): Promise<void>;
  stopTagSharing(input: { tagId: string }): Promise<void>;
  syncTagShare(input: { tagId: string }): Promise<unknown>;
}
