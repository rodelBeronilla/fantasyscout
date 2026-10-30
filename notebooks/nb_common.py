"""Cells every notebook shares (make_notebooks.py)."""

SETUP = """import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from IPython.display import display

from fs import columns, connect, describe, has_table, insufficient, leagues, save_findings

pd.set_option('display.width', 160)
pd.set_option('display.max_columns', 30)
con = connect()
PRESENT = leagues(con)
LEAGUES = ['wnba', 'nba']  # every notebook answers for both, saying so when a league has too little
LABEL = {'wnba': 'WNBA', 'nba': 'NBA'}
COLOR = {'wnba': '#b23a0a', 'nba': '#1a7f4b'}
findings = {}
print(describe(con), 'Leagues with games:', ', '.join(LABEL[lg] for lg in PRESENT) or 'none')"""


def setup() -> tuple[str, str]:
    return ("code", SETUP)
