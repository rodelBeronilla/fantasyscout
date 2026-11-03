"""The validator (SPEC.md, step 3): a drafted note is published only if every number in it is the
build's.

The model writes words; the validator writes the claims. A draft passes when it fits the schema,
is about the player it was asked about, states at least one number, and every number in its
headline and body is one of the input's numbers (a metric's ``before``, ``after`` or ``change``,
as rounded in the input; a share may be written as a percentage). Each such number becomes a
claim naming the metric, the input's exact value and its row. Anything else drops the note, with
the reasons, for the rejection log.
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import ValidationError

from ai.schema import Claim, Draft, Note

NUMBER = re.compile(r"(?<![\w.])[-+\u2212]?\d+(?:[.,]\d+)?%?")
# when one value appears twice, a written number is taken as the newer figure first
ORDER = ("after", "change", "before")


def numbers_in(text: str) -> list[tuple[str, float]]:
    """Each number written in the text: as written, and its value."""
    found = []
    for token in NUMBER.findall(text):
        cleaned = token.replace("\u2212", "-").replace(",", ".").rstrip("%")
        try:
            found.append((token, float(cleaned)))
        except ValueError:
            continue
    return found


def _forms(metric: str, value: float) -> list[float]:
    """The ways a number may be written: as given, without its sign, and a share as a percentage."""
    out = [value, abs(value)]
    if metric == "availability_share":
        out += [value * 100, abs(value) * 100]
    return out


def decimals_of(token: str) -> int:
    digits = token.rstrip("%").replace(",", ".")
    return len(digits.split(".", 1)[1]) if "." in digits else 0


def trace(written: float, inp: dict[str, Any], decimals: int = 1) -> Claim | None:
    """The input's number a written number is, as a claim; None when it is none of them. A number
    is the input's when it is that number rounded to the precision it is written in: "13" may
    stand for 13.4, "2.3" must be 2.3, so a change of 2.3 is never read as a rank of 2."""
    tol = 0.5 * 10**-decimals + 1e-9
    for part in ORDER:
        for metric, values in inp.get("metrics", {}).items():
            v = values.get(part)
            if v is not None and any(
                abs(written - form) <= tol for form in _forms(metric, float(v))
            ):
                return Claim(metric=f"{metric}.{part}", value=float(v), row_ref=inp["row_ref"])
    return None


# words that say which way a change went: the number itself (up/down), or for the better or worse
NUMERIC_UP = {
    "rose",
    "rise",
    "rises",
    "increased",
    "increases",
    "up",
    "climbed",
    "grew",
    "jumped",
    "higher",
    "added",
}
NUMERIC_DOWN = {
    "fell",
    "fall",
    "falls",
    "dropped",
    "drops",
    "decreased",
    "decreases",
    "down",
    "declined",
    "lower",
    "slid",
}
BETTER = {"improved", "improves", "better", "gained", "boosted", "boost"}
WORSE = {"worsened", "worse", "slipped", "lost", "sank"}
WINDOW = 6
# the metrics where a lower number is the better one
LOWER_IS_BETTER = {"rank"}


def direction_error(claim: Claim, inp: dict[str, Any], words_before: list[str]) -> str | None:
    """Whether the words just before a change contradict its sign: "rose" for a fall, or "improved"
    for a rank that went up."""
    metric, _, part = claim.metric.partition(".")
    if part != "change" or claim.value == 0:
        return None
    up = claim.value > 0
    better = (not up) if metric in LOWER_IS_BETTER else up
    near = {w.strip(".,;:()").lower() for w in words_before[-WINDOW:]}
    if metric in LOWER_IS_BETTER:
        # a rank that "rose" or "climbed" reads as a better rank, whatever its number did
        said_better = bool(near & (NUMERIC_UP | BETTER))
        said_worse = bool(near & (NUMERIC_DOWN | WORSE))
        if (said_better and not better) or (said_worse and better):
            said = "better" if said_better else "worse"
            return f"the text calls the change in {metric} {said}, which it is not"
        return None
    if (near & NUMERIC_UP and not up) or (near & NUMERIC_DOWN and up):
        return f"the text says {claim.metric} went the wrong way (it is {claim.value:+g})"
    if (near & BETTER and not better) or (near & WORSE and better):
        said = "better" if near & BETTER else "worse"
        return f"the text calls the change in {metric} {said}, which it is not"
    return None


def check(raw: Any, inp: dict[str, Any]) -> tuple[Note | None, list[str]]:
    """The note, with its claims, if it passes; and why it does not."""
    try:
        draft = Draft.model_validate(raw)
    except ValidationError as e:
        return None, [f"schema: {err['loc']}: {err['msg']}" for err in e.errors()][:5]
    reasons: list[str] = []
    if draft.player_id != inp["player_id"]:
        reasons.append(f"about {draft.player_id}, asked about {inp['player_id']}")
    claims: list[Claim] = []
    text = f"{draft.headline}. {draft.body}"
    for match in NUMBER.finditer(text):
        token = match.group(0)
        try:
            value = float(token.replace("\u2212", "-").replace(",", ".").rstrip("%"))
        except ValueError:
            continue
        claim = trace(value, inp, decimals_of(token))
        if claim is None:
            reasons.append(f"the text states {token}, which is not one of the build's numbers")
            continue
        # the words since the previous number, at most WINDOW of them
        before = re.split(r"\d", text[: match.start()])[-1].split()
        wrong = direction_error(claim, inp, before)
        if wrong:
            reasons.append(wrong)
        if all(c.metric != claim.metric for c in claims):
            claims.append(claim)
    if not claims and not reasons:
        reasons.append("the note states no number from the build")
    if "confidence" in draft.body.lower():
        reasons.append("the body talks about its own confidence")
    if reasons:
        return None, reasons
    return Note(**draft.model_dump(), claims=claims), []
