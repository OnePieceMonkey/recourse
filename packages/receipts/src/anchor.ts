// Anchoring makes the log head provable to third parties: once a head hash is
// stamped into Bitcoin, nobody (including Recourse) can rewrite earlier entries
// without the mismatch being visible.
export interface AnchorProof {
  headSeq: number;
  headHash: string;
  method: "opentimestamps" | "none";
  proof: string; // base64 of the .ots file, empty for "none"
  status: "pending" | "confirmed";
  bitcoinBlock?: number;
}

export interface Anchorer {
  stamp(headSeq: number, headHash: string): Promise<AnchorProof>;
  upgrade(proof: AnchorProof): Promise<AnchorProof>;
}

// Used in tests and when OTS calendars are unreachable; the chain stays verifiable,
// it just has no external timestamp.
export const noopAnchorer: Anchorer = {
  async stamp(headSeq, headHash) {
    return { headSeq, headHash, method: "none", proof: "", status: "pending" };
  },
  async upgrade(proof) {
    return proof;
  },
};
