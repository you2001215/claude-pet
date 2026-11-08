#!/usr/bin/env bash
# CI only (macOS): puts a code-signing certificate into a throwaway keychain for scripts/mac-sign.js.
# - with secrets MAC_CERT_P12 (base64 of the .p12) and MAC_CERT_PASSWORD: the owner's own self-signed certificate
#   ("ClaudePet Code Signing"), so every build has the same designated requirement and macOS keeps the screen
#   recording / microphone permissions across versions;
# - without them (forks, before the owner has set it up): a certificate made up on the spot, only to rehearse the
#   signing on a copy of the app. The real build then stays ad-hoc, as before.
# Prints nothing secret. Writes mode / keychain / sha1 to $GITHUB_OUTPUT.
set -euo pipefail
T="${RUNNER_TEMP:?}"
KC="$T/pet-signing.keychain-db"
KCPASS="$(/usr/bin/openssl rand -hex 16)"
security create-keychain -p "$KCPASS" "$KC"
security set-keychain-settings -lut 3600 "$KC"
security unlock-keychain -p "$KCPASS" "$KC"

if [ -n "${MAC_CERT_P12:-}" ] && [ -n "${MAC_CERT_PASSWORD:-}" ]; then
  MODE=real
  # the secret has to be the base64 of the .p12 (what `base64 -i ClaudePet.p12 | pbcopy` puts on the clipboard),
  # not the command itself: say so plainly instead of failing somewhere further down
  if ! printf '%s' "$MAC_CERT_P12" | tr -d ' \n\r' | base64 --decode > "$T/pet-cert.p12" 2>/dev/null || [ "$(wc -c < "$T/pet-cert.p12")" -lt 500 ]; then
    echo "::error::MAC_CERT_P12 不是证书的 base64（解不出 .p12）。请重新导出证书，在终端运行 base64 -i ~/Desktop/ClaudePet.p12 | pbcopy，再到 GitHub 的 MAC_CERT_P12 里粘贴（应该是一大串乱码，不是那行命令）"
    exit 1
  fi
  P12PASS="$MAC_CERT_PASSWORD"
else
  MODE=rehearsal
  cat > "$T/pet-cert.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = ClaudePet Rehearsal (throwaway)
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config "$T/pet-cert.cnf" -keyout "$T/pet-key.pem" -out "$T/pet-cert.pem" 2>/dev/null
  P12PASS="$(/usr/bin/openssl rand -hex 12)"
  /usr/bin/openssl pkcs12 -export -inkey "$T/pet-key.pem" -in "$T/pet-cert.pem" -out "$T/pet-cert.p12" -passout "pass:$P12PASS"
  rm -f "$T/pet-key.pem" "$T/pet-cert.cnf"
fi

if ! security import "$T/pet-cert.p12" -k "$KC" -P "$P12PASS" -T /usr/bin/codesign >/dev/null; then
  rm -f "$T/pet-cert.p12"
  echo "::error::证书导不进去：多半是 MAC_CERT_PASSWORD 和导出 .p12 时设的密码不一样（或者 .p12 坏了）"
  exit 1
fi
rm -f "$T/pet-cert.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPASS" "$KC" >/dev/null
# search this keychain too (keep the others)
security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')

# the certificate (the only one in this keychain) and its SHA-1, which is what the designated requirement names
security find-certificate -a -p "$KC" > "$T/pet-cert.pem"
SHA1="$(/usr/bin/openssl x509 -in "$T/pet-cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')"
# trusted for code signing on this throwaway runner only (the owner's own Mac never needs this)
sudo security add-trusted-cert -d -r trustRoot -p codeSign -k "$KC" "$T/pet-cert.pem" \
  || echo "::warning::could not mark the certificate as trusted; signing by fingerprint may still work"
rm -f "$T/pet-cert.pem"

echo "signing certificate: $MODE, sha1 $SHA1"
{ echo "mode=$MODE"; echo "keychain=$KC"; echo "sha1=$SHA1"; } >> "${GITHUB_OUTPUT:-/dev/null}"
