import OpenTimestamps from "opentimestamps";
import type { Anchorer, AnchorProof } from "./anchor";

// Stamps a log head into Bitcoin through the public OpenTimestamps calendars.
// Only the 32-byte hash leaves the machine. A proof is "pending" until the
// calendars have committed it to a block (usually a few hours).
export function openTimestampsAnchorer(): Anchorer {
  const { DetachedTimestampFile, Ops } = OpenTimestamps;
  return {
    async stamp(headSeq, headHash) {
      const detached = DetachedTimestampFile.fromHash(new Ops.OpSHA256(), Buffer.from(headHash, "hex"));
      await OpenTimestamps.stamp(detached);
      return {
        headSeq,
        headHash,
        method: "opentimestamps",
        proof: Buffer.from(detached.serializeToBytes()).toString("base64"),
        status: detached.timestamp.isTimestampComplete() ? "confirmed" : "pending",
      };
    },
    async upgrade(proof: AnchorProof) {
      if (proof.method !== "opentimestamps" || proof.status === "confirmed") return proof;
      const detached = DetachedTimestampFile.deserialize(Buffer.from(proof.proof, "base64"));
      const changed = await OpenTimestamps.upgrade(detached);
      if (!changed) return proof;
      const complete = detached.timestamp.isTimestampComplete();
      let bitcoinBlock: number | undefined;
      if (complete) {
        const result = (await OpenTimestamps.verifyTimestamp(detached.timestamp, { ignoreBitcoinNode: true, timeout: 10_000 } as never)) as {
          bitcoin?: { height?: number };
        };
        bitcoinBlock = result?.bitcoin?.height;
      }
      return {
        ...proof,
        proof: Buffer.from(detached.serializeToBytes()).toString("base64"),
        status: complete ? "confirmed" : "pending",
        ...(bitcoinBlock ? { bitcoinBlock } : {}),
      };
    },
  };
}
