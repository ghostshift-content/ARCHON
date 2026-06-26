#!/usr/bin/env python3
"""
Unified report generator for AI Security Arsenal.
Aggregates findings from multiple skills into HTML/JSON/Markdown reports.
"""

import json
import sys
import os
from datetime import datetime
from pathlib import Path
from collections import defaultdict

SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
SEVERITY_COLORS = {
    "critical": "#dc3545",
    "high": "#fd7e14",
    "medium": "#ffc107",
    "low": "#0dcaf0",
    "info": "#6c757d",
}


def load_findings(findings_dir: str) -> list:
    """Load all JSON finding files from a directory."""
    findings = []
    findings_path = Path(findings_dir)
    for f in findings_path.glob("**/*.json"):
        try:
            with open(f) as fh:
                data = json.load(fh)
                if isinstance(data, list):
                    findings.extend(data)
                elif isinstance(data, dict) and "findings" in data:
                    findings.extend(data["findings"])
                elif isinstance(data, dict) and "id" in data:
                    findings.append(data)
        except (json.JSONDecodeError, KeyError):
            continue
    return findings


def sort_findings(findings: list) -> list:
    """Sort findings by severity."""
    return sorted(findings, key=lambda f: SEVERITY_ORDER.get(f.get("severity", "info"), 5))


def severity_counts(findings: list) -> dict:
    """Count findings per severity."""
    counts = defaultdict(int)
    for f in findings:
        counts[f.get("severity", "info")] += 1
    return dict(counts)


def generate_markdown(findings: list, title: str = "Security Assessment Report") -> str:
    """Generate markdown report."""
    counts = severity_counts(findings)
    sorted_findings = sort_findings(findings)

    lines = [
        f"# {title}",
        "",
        f"**Generated**: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"**Total Findings**: {len(findings)}",
        "",
        "## Summary",
        "",
        "| Severity | Count |",
        "|----------|-------|",
    ]
    for sev in ["critical", "high", "medium", "low", "info"]:
        if counts.get(sev, 0) > 0:
            lines.append(f"| {sev.upper()} | {counts[sev]} |")

    lines.extend(["", "## Findings", ""])

    for i, f in enumerate(sorted_findings, 1):
        sev = f.get("severity", "info").upper()
        lines.append(f"### {i}. [{sev}] {f.get('title', 'Untitled')}")
        lines.append("")
        if f.get("skill"):
            lines.append(f"**Skill**: {f['skill']}")
        if f.get("cwe_id"):
            lines.append(f"**CWE**: {f['cwe_id']}")
        if f.get("owasp_id"):
            lines.append(f"**OWASP**: {f['owasp_id']}")
        if f.get("cvss_score"):
            lines.append(f"**CVSS**: {f['cvss_score']}")
        lines.append("")
        if f.get("description"):
            lines.append(f"**Description**: {f['description']}")
            lines.append("")
        if f.get("affected_component"):
            lines.append(f"**Affected**: {f['affected_component']}")
            lines.append("")
        if f.get("impact"):
            lines.append(f"**Impact**: {f['impact']}")
            lines.append("")
        if f.get("remediation"):
            lines.append(f"**Remediation**: {f['remediation']}")
            lines.append("")
        if f.get("evidence", {}).get("reproduction_steps"):
            lines.append("**Reproduction Steps**:")
            for step in f["evidence"]["reproduction_steps"]:
                lines.append(f"1. {step}")
            lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines)


def generate_html(findings: list, title: str = "Security Assessment Report") -> str:
    """Generate HTML report."""
    counts = severity_counts(findings)
    sorted_findings = sort_findings(findings)
    rows = ""
    for f in sorted_findings:
        sev = f.get("severity", "info")
        color = SEVERITY_COLORS.get(sev, "#6c757d")
        rows += f"""
        <tr>
            <td><span style="background:{color};color:#fff;padding:2px 8px;border-radius:4px">{sev.upper()}</span></td>
            <td>{f.get('title','')}</td>
            <td>{f.get('skill','')}</td>
            <td>{f.get('cwe_id','')}</td>
            <td>{f.get('cvss_score','')}</td>
            <td>{f.get('affected_component','')}</td>
        </tr>"""

    return f"""<!DOCTYPE html>
<html><head><title>{title}</title>
<style>
body {{ font-family: -apple-system, sans-serif; margin: 2em; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
th {{ background: #f5f5f5; }}
.summary {{ display: flex; gap: 1em; margin: 1em 0; }}
.card {{ padding: 1em; border-radius: 8px; color: #fff; min-width: 100px; text-align: center; }}
</style></head><body>
<h1>{title}</h1>
<p>Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')} | Total: {len(findings)} findings</p>
<div class="summary">
{''.join(f'<div class="card" style="background:{SEVERITY_COLORS[s]}">{s.upper()}<br><b>{counts.get(s,0)}</b></div>' for s in ["critical","high","medium","low","info"])}
</div>
<table><tr><th>Severity</th><th>Title</th><th>Skill</th><th>CWE</th><th>CVSS</th><th>Component</th></tr>
{rows}
</table></body></html>"""


def main():
    if len(sys.argv) < 2:
        print("Usage: report_generator.py <findings_dir> [--format md|html|json] [--output file]")
        sys.exit(1)

    findings_dir = sys.argv[1]
    fmt = "md"
    output = None

    for i, arg in enumerate(sys.argv):
        if arg == "--format" and i + 1 < len(sys.argv):
            fmt = sys.argv[i + 1]
        if arg == "--output" and i + 1 < len(sys.argv):
            output = sys.argv[i + 1]

    findings = load_findings(findings_dir)
    if not findings:
        print(f"No findings found in {findings_dir}")
        sys.exit(0)

    if fmt == "html":
        result = generate_html(findings)
    elif fmt == "json":
        result = json.dumps(sort_findings(findings), indent=2)
    else:
        result = generate_markdown(findings)

    if output:
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        with open(output, "w") as f:
            f.write(result)
        print(f"Report written to {output}")
    else:
        print(result)


if __name__ == "__main__":
    main()
