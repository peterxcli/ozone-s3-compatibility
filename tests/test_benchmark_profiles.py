from pathlib import Path

from scripts.benchmark_profiles import load_profiles, render_warp_command


def test_load_profiles_expands_workload_dimensions() -> None:
    profiles = load_profiles(Path("benchmark/profiles/extended.json"))
    ids = {profile.profile_id for profile in profiles}

    assert "put-small-c01-prefix" in ids
    assert "get-range-medium-c16-prefix" in ids
    assert "multipart-put-large-c04-prefix" in ids
    assert all(profile.duration_seconds > 0 for profile in profiles)
    assert all(profile.objects >= 6400 for profile in profiles if profile.workload == "delete")


def test_load_smoke_profiles_for_manual_dispatch() -> None:
    profiles = load_profiles(Path("benchmark/profiles/smoke.json"))

    assert {profile.workload for profile in profiles} == {"put", "get", "mixed", "list", "multipart-put"}
    assert len(profiles) == 5
    assert all(profile.duration_seconds == 5 for profile in profiles)


def test_render_warp_command_includes_common_and_workload_flags() -> None:
    profile = next(
        profile
        for profile in load_profiles(Path("benchmark/profiles/extended.json"))
        if profile.profile_id == "get-range-medium-c16-prefix"
    )

    command = render_warp_command(
        warp_binary="./warp/warp",
        profile=profile,
        host="127.0.0.1:9000",
        access_key="minio",
        secret_key="minio123",
        bucket="warp-benchmark",
        benchdata_path="out/provider/get.csv.zst",
        analyze_out_path="out/provider/get-timeseries.csv",
    )

    assert command[:2] == ["./warp/warp", "get"]
    assert "--host=127.0.0.1:9000" in command
    assert "--access-key=minio" in command
    assert "--secret-key=minio123" in command
    assert "--bucket=warp-benchmark" in command
    assert "--obj.size=1MiB" in command
    assert "--concurrent=16" in command
    assert "--range" in command
    assert "--benchdata=out/provider/get.csv.zst" in command
    assert "--analyze.out=out/provider/get-timeseries.csv" in command


def test_render_warp_command_only_includes_objects_for_supported_workloads() -> None:
    profiles = load_profiles(Path("benchmark/profiles/extended.json"))

    commands = {
        profile.profile_id: render_warp_command(
            warp_binary="./warp/warp",
            profile=profile,
            host="127.0.0.1:9000",
            access_key="minio",
            secret_key="minio123",
            bucket="warp-benchmark",
            benchdata_path=f"out/provider/{profile.profile_id}.csv.zst",
            analyze_out_path=f"out/provider/{profile.profile_id}-timeseries.csv",
        )
        for profile in profiles
    }

    assert not any(flag.startswith("--objects=") for flag in commands["put-small-c01-prefix"])
    assert not any(flag.startswith("--objects=") for flag in commands["multipart-put-large-c04-prefix"])
    assert "--objects=6400" in commands["delete-small-c16-prefix"]
