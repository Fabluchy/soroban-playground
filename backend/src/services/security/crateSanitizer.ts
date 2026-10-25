import AdmZip from 'adm-zip';
import * as path from 'path';

export interface SanitizationResult {
  isSafe: boolean;
  error?: string;
  fileCount: number;
  totalSizeMb: number;
}

const MAX_FILES = 500;
const MAX_UNCOMPRESSED_SIZE_MB = 50;
const BYTES_PER_MB = 1024 * 1024;

// Suspicious patterns in build.rs scripts
const SUSPICIOUS_BUILD_PATTERNS = [
  /std::net::TcpStream/i,
  /std::net::UdpSocket/i,
  /std::process::Command/i,
  /std::fs::remove_dir_all\("\/"\)/i,
  /reqwest::blocking::get/i,
  /File::create\("\/etc\//i,
];

export class CrateSanitizerService {
  /**
   * Securely inspect and sanitize an uploaded crate archive (.zip)
   */
  public static async sanitizeZipBuffer(
    fileBuffer: Buffer
  ): Promise<SanitizationResult> {
    try {
      const zip = new AdmZip(fileBuffer);
      const zipEntries = zip.getEntries();

      let fileCount = 0;
      let totalUncompressedBytes = 0;

      // 1. Enforce file count limit
      if (zipEntries.length > MAX_FILES) {
        return {
          isSafe: false,
          error: `Crate rejected: Contains ${zipEntries.length} files, exceeding the maximum allowed limit of ${MAX_FILES}.`,
          fileCount: zipEntries.length,
          totalSizeMb: 0,
        };
      }

      for (const entry of zipEntries) {
        if (entry.isDirectory) continue;
        fileCount++;
        totalUncompressedBytes += entry.header.size;

        const entryName = entry.entryName;

        // 2. Guard against Zip-Slip Path Traversal Attacks
        if (entryName.includes('..') || path.isAbsolute(entryName)) {
          return {
            isSafe: false,
            error: `Security Violation: Potential Zip-Slip path traversal detected in entry: "${entryName}".`,
            fileCount,
            totalSizeMb: totalUncompressedBytes / BYTES_PER_MB,
          };
        }

        // 3. Inspect build.rs scripts for malicious network or system execution calls
        if (path.basename(entryName) === 'build.rs') {
          const buildRsContent = entry.getData().toString('utf8');
          for (const pattern of SUSPICIOUS_BUILD_PATTERNS) {
            if (pattern.test(buildRsContent)) {
              return {
                isSafe: false,
                error: `Security Violation: Malicious or unauthorized system call detected in "build.rs" matching pattern: ${pattern}`,
                fileCount,
                totalSizeMb: totalUncompressedBytes / BYTES_PER_MB,
              };
            }
          }
        }
      }

      // 4. Enforce Uncompressed Size Limit (Zip-Bomb protection)
      const totalSizeMb = totalUncompressedBytes / BYTES_PER_MB;
      if (totalSizeMb > MAX_UNCOMPRESSED_SIZE_MB) {
        return {
          isSafe: false,
          error: `Crate rejected: Uncompressed size (${totalSizeMb.toFixed(
            2
          )}MB) exceeds the maximum allowed limit of ${MAX_UNCOMPRESSED_SIZE_MB}MB (Possible Zip-Bomb).`,
          fileCount,
          totalSizeMb,
        };
      }

      return {
        isSafe: true,
        fileCount,
        totalSizeMb,
      };
    } catch (err: any) {
      return {
        isSafe: false,
        error: `Failed to parse crate archive: ${err.message}`,
        fileCount: 0,
        totalSizeMb: 0,
      };
    }
  }
}
