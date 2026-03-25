import subprocess
import json

try:
    output = subprocess.check_output(
        ['git', 'diff', 'ae9de8875c7e498bcfbe8d0ae03f2835ae8b0fd3^', 'ae9de8875c7e498bcfbe8d0ae03f2835ae8b0fd3'],
        text=True
    )
    with open('diff_output.json', 'w', encoding='utf-8') as f:
        json.dump({"raw": output}, f, indent=2)
except Exception as e:
    with open('diff_output.json', 'w', encoding='utf-8') as f:
        json.dump({"error": str(e)}, f)
