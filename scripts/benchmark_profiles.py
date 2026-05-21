#!/usr/bin/env python3

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class BenchmarkProfile:
    profile_id: str
    workload: str
    command: str
    operation: str
    object_size: str
    size_key: str
    size_flag: str
    concurrency: int
    concurrency_key: str
    prefix_mode: str
    noprefix: bool
    duration_seconds: int
    objects: int
    include_objects: bool
    analyze_duration: str
    extra_flags: list[str] = field(default_factory=list)

    def to_record(self) -> dict[str, Any]:
        return {
            "profile_id": self.profile_id,
            "workload": self.workload,
            "command": self.command,
            "operation": self.operation,
            "object_size": self.object_size,
            "size_key": self.size_key,
            "size_flag": self.size_flag,
            "concurrency": self.concurrency,
            "concurrency_key": self.concurrency_key,
            "prefix_mode": self.prefix_mode,
            "noprefix": self.noprefix,
            "duration_seconds": self.duration_seconds,
            "objects": self.objects,
            "include_objects": self.include_objects,
            "analyze_duration": self.analyze_duration,
            "extra_flags": list(self.extra_flags),
        }


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def keyed(records: list[dict[str, Any]], key: str = "key") -> dict[str, dict[str, Any]]:
    return {str(record[key]): record for record in records}


def profile_id(workload: str, size_key: str, concurrency_key: str, prefix_mode: str) -> str:
    return f"{workload}-{size_key}-{concurrency_key}-{prefix_mode}"


def load_profiles(path: Path) -> list[BenchmarkProfile]:
    config = load_json(path)
    defaults = config.get("defaults", {})
    sizes = keyed(config.get("sizes", []))
    concurrency = keyed(config.get("concurrency", []))
    prefix_modes = keyed(config.get("prefix_modes", []))
    profiles: list[BenchmarkProfile] = []
    object_count_commands = {"delete", "get", "list", "mixed", "stat"}

    for workload in config.get("workloads", []):
        workload_key = str(workload["key"])
        command_name = str(workload["command"])
        for size_key in workload.get("size_keys", []):
            size = sizes[str(size_key)]
            for concurrency_key in workload.get("concurrency_keys", []):
                concurrency_record = concurrency[str(concurrency_key)]
                for prefix_mode_key in workload.get("prefix_mode_keys", []):
                    prefix_mode = prefix_modes[str(prefix_mode_key)]
                    profiles.append(
                        BenchmarkProfile(
                            profile_id=profile_id(
                                workload_key,
                                str(size_key),
                                str(concurrency_key),
                                str(prefix_mode_key),
                            ),
                            workload=workload_key,
                            command=command_name,
                            operation=str(workload.get("operation") or workload["command"]).upper(),
                            object_size=str(size["object_size"]),
                            size_key=str(size_key),
                            size_flag=str(workload.get("size_flag") or "--obj.size"),
                            concurrency=int(concurrency_record["value"]),
                            concurrency_key=str(concurrency_key),
                            prefix_mode=str(prefix_mode_key),
                            noprefix=bool(prefix_mode.get("noprefix", False)),
                            duration_seconds=int(workload.get("duration_seconds") or defaults.get("duration_seconds", 30)),
                            objects=int(workload.get("objects") or defaults.get("objects", 512)),
                            include_objects=bool(workload.get("include_objects", command_name in object_count_commands)),
                            analyze_duration=str(workload.get("analyze_duration") or defaults.get("analyze_duration", "1s")),
                            extra_flags=[str(flag) for flag in workload.get("extra_flags", [])],
                        )
                    )

    return profiles


def render_warp_command(
    *,
    warp_binary: str,
    profile: BenchmarkProfile,
    host: str,
    access_key: str,
    secret_key: str,
    bucket: str,
    benchdata_path: str,
    analyze_out_path: str,
) -> list[str]:
    command = [
        warp_binary,
        profile.command,
        f"--host={host}",
        f"--access-key={access_key}",
        f"--secret-key={secret_key}",
        f"--bucket={bucket}",
        f"--duration={profile.duration_seconds}s",
        f"--concurrent={profile.concurrency}",
        f"{profile.size_flag}={profile.object_size}",
        f"--benchdata={benchdata_path}",
        f"--analyze.out={analyze_out_path}",
        f"--analyze.dur={profile.analyze_duration}",
        "--autoterm",
    ]
    if profile.include_objects:
        command.append(f"--objects={profile.objects}")
    if profile.noprefix:
        command.append("--noprefix")
    command.extend(profile.extra_flags)
    return command
