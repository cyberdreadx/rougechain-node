import { describe, expect, it } from "vitest";
import { safeAttachmentTarget } from "../src/lib/pqc-mail";

describe("received mail attachments: name and type are sender-controlled", () => {
    it("keeps an ordinary file name and an allowed type", () => {
        expect(safeAttachmentTarget({ name: "Report (final).pdf", type: "application/pdf" })).toEqual({ name: "Report (final).pdf", type: "application/pdf" });
        expect(safeAttachmentTarget({ name: "photo.PNG", type: "IMAGE/PNG" })).toEqual({ name: "photo.PNG", type: "image/png" });
    });

    it("drops directories and unsafe characters from the name", () => {
        expect(safeAttachmentTarget({ name: "../../etc/passwd", type: "text/plain" }).name).toBe("passwd");
        expect(safeAttachmentTarget({ name: "C:\\Users\\x\\evil.txt", type: "text/plain" }).name).toBe("evil.txt");
        expect(safeAttachmentTarget({ name: "a<b>:c?.txt", type: "text/plain" }).name).toBe("a_b__c_.txt");
        expect(safeAttachmentTarget({ name: "...hidden", type: "text/plain" }).name).toBe("hidden");
        expect(safeAttachmentTarget({ name: "", type: "text/plain" }).name).toBe("attachment");
        expect(safeAttachmentTarget({ name: "x".repeat(300) + ".txt", type: "text/plain" }).name.length).toBe(100);
    });

    it("never hands the browser an active content type", () => {
        for (const type of ["text/html", "image/svg+xml", "application/javascript", "application/xhtml+xml", "", "weird"]) {
            expect(safeAttachmentTarget({ name: "f", type }).type).toBe("application/octet-stream");
        }
    });
});
