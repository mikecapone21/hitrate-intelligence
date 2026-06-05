#!/usr/bin/env python3
"""
Fetch Google Trends interest data for a list of card names.
Usage: python3 trends.py "Card Name 1" "Card Name 2" ...
Output: JSON with trend score (0-100) and direction for each card.
"""
import sys
import json
import time

try:
    from pytrends.request import TrendReq
except ImportError:
    print(json.dumps({"error": "pytrends not installed"}))
    sys.exit(1)

def get_trends(keywords):
    pytrends = TrendReq(hl='en-US', tz=360, timeout=(10, 25))
    results = {}

    # Pytrends can compare up to 5 keywords at a time
    chunks = [keywords[i:i+5] for i in range(0, len(keywords), 5)]

    for chunk in chunks:
        try:
            pytrends.build_payload(chunk, cat=0, timeframe='today 3-m', geo='US')
            df = pytrends.interest_over_time()

            if df is None or df.empty:
                for kw in chunk:
                    results[kw] = {"score": 0, "direction": "flat", "peak": 0}
                continue

            for kw in chunk:
                if kw not in df.columns:
                    results[kw] = {"score": 0, "direction": "flat", "peak": 0}
                    continue

                series = df[kw].tolist()
                if not series:
                    results[kw] = {"score": 0, "direction": "flat", "peak": 0}
                    continue

                # Current score = average of last 2 weeks
                recent = series[-14:] if len(series) >= 14 else series
                prev   = series[-28:-14] if len(series) >= 28 else series[:max(1, len(series)//2)]

                current_avg = sum(recent) / len(recent) if recent else 0
                prev_avg    = sum(prev)   / len(prev)   if prev   else 0
                peak        = max(series) if series else 0

                if prev_avg == 0:
                    direction = "up" if current_avg > 5 else "flat"
                elif current_avg > prev_avg * 1.15:
                    direction = "up"
                elif current_avg < prev_avg * 0.85:
                    direction = "down"
                else:
                    direction = "flat"

                results[kw] = {
                    "score":     round(current_avg),
                    "direction": direction,
                    "peak":      round(peak),
                }

            if len(chunks) > 1:
                time.sleep(2)  # avoid burst rate limit between chunks

        except Exception as e:
            for kw in chunk:
                results[kw] = {"score": None, "direction": "unknown", "error": str(e)}

    return results

if __name__ == "__main__":
    keywords = sys.argv[1:]
    if not keywords:
        print(json.dumps({"error": "no keywords provided"}))
        sys.exit(1)
    output = get_trends(keywords)
    print(json.dumps(output))
