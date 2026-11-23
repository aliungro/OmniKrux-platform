"""Notification channels read from an Alertmanager's routes."""

import pytest

from omnikrux.monitoring.alerts.tool.channels import (
    PATTERN_REASON,
    ChannelsUnreadable,
    parse_channels,
    read_channels,
)

CONFIG = """
route:
  receiver: default-mail
  routes:
    - receiver: ops-slack
      matchers: ['team="ops"', 'severity=~"critical|warning"']
    - receiver: db-pager
      match: {team: db}
    - receiver: sre
      matchers: ['team="sre"']
"""


def test_channels_follow_routes():
    assert [(c.receiver, dict(c.labels), c.usable) for c in parse_channels(CONFIG)] == [
        ("default-mail", {}, True),
        ("ops-slack", {"team": "ops"}, False),
        ("db-pager", {"team": "db"}, True),
        ("sre", {"team": "sre"}, True),
    ]


def test_channels_say_why_and_where():
    channels = parse_channels(CONFIG)
    assert [c.path for c in channels] == ["default", "routes[0]", "routes[1]", "routes[2]"]
    assert channels[1].reason == PATTERN_REASON and channels[2].reason is None


def test_nested_routes_inherit_receiver_and_parent_labels_and_duplicates_collapse():
    channels = parse_channels(
        """
route:
  receiver: root
  routes:
    - matchers: ['team="a"']
      receiver: a
      routes:
        - matchers: ['severity="page"']
        - match_re: {env: "pr.*"}
          receiver: b
    - receiver: a
      match: {team: a}
"""
    )
    assert [(c.receiver, dict(c.labels), c.usable, c.path) for c in channels] == [
        ("root", {}, True, "default"),
        ("a", {"team": "a"}, True, "routes[0]"),
        ("a", {"team": "a", "severity": "page"}, True, "routes[0].routes[0]"),
        ("b", {"team": "a"}, False, "routes[0].routes[1]"),
    ]


def test_unreadable_configuration():
    with pytest.raises(ChannelsUnreadable):
        parse_channels("route: [unclosed")
    with pytest.raises(ChannelsUnreadable):
        parse_channels("receivers: []")


async def test_read_channels_from_the_status(fake_alertmanager, direct):
    fake_alertmanager.config_yaml = CONFIG
    t = direct(fake_alertmanager.url, type="alertmanager", name="Alerts")
    assert [c.receiver for c in await read_channels(t, "Alerts")] == [
        "default-mail",
        "ops-slack",
        "db-pager",
        "sre",
    ]
    fake_alertmanager.config_yaml = "route: [unclosed"
    with pytest.raises(ChannelsUnreadable) as caught:
        await read_channels(t, "Alerts")
    assert caught.value.message == (
        "Alerts's configuration couldn't be read, so its channels can't be listed."
    )


def shapes(config: str):
    return [(c.receiver, c.usable, c.reason) for c in parse_channels(config)]


SHADOW = "An earlier route catches these alerts first, so they never reach this one."


def test_a_catch_all_sibling_shadows_everything_after_it_and_the_default():
    got = shapes(
        """
route:
  receiver: root
  routes:
    - receiver: all
    - receiver: later
      matchers: ['team="a"']
"""
    )
    assert got == [("root", False, SHADOW), ("all", True, None), ("later", False, SHADOW)]


def test_an_equal_or_broader_earlier_sibling_shadows():
    got = shapes(
        """
route:
  receiver: root
  routes:
    - receiver: first
      matchers: ['team="a"']
    - receiver: second
      matchers: ['team="a"', 'severity="page"']
    - receiver: third
      match: {team: a}
"""
    )
    assert got == [
        ("root", True, None),
        ("first", True, None),
        ("second", False, SHADOW),
        ("third", False, SHADOW),
    ]


def test_continue_does_not_save_a_parent_from_a_matching_child():
    got = shapes(
        """
route:
  receiver: root
  routes:
    - receiver: first
      continue: true
      matchers: ['team="a"']
    - receiver: second
      matchers: ['team="a"', 'severity="page"']
    - receiver: all
      continue: true
    - receiver: last
      matchers: ['team="z"']
"""
    )
    # The catch-all child takes everything the root would get, `continue` or not; `first` has
    # `continue`, so `second` is still tried.
    assert got == [
        ("root", False, SHADOW),
        ("first", True, None),
        ("second", True, None),
        ("all", True, None),
        ("last", True, None),
    ]


def test_a_narrower_child_leaves_the_parent_usable():
    got = shapes(
        """
route:
  receiver: root
  routes:
    - receiver: a
      matchers: ['team="a"']
      routes:
        - receiver: page
          matchers: ['severity="page"']
"""
    )
    assert [u for _, u, _ in got] == [True, True, True]
    shadowed = shapes(
        """
route:
  receiver: root
  routes:
    - receiver: a
      matchers: ['team="a"']
      routes:
        - receiver: same
          matchers: ['team="a"']
"""
    )
    assert [(r, u) for r, u, _ in shadowed] == [("root", True), ("a", False), ("same", True)]


def test_a_sibling_is_compared_by_its_inherited_labels_too():
    got = shapes(
        """
route:
  receiver: root
  matchers: ['team="a"']
  routes:
    - receiver: first
      matchers: ['team="a"']
    - receiver: second
      matchers: ['severity="page"']
"""
    )
    assert [(r, u) for r, u, _ in got] == [("root", False), ("first", True), ("second", False)]


def test_a_narrower_earlier_sibling_does_not_shadow():
    got = shapes(
        """
route:
  receiver: root
  routes:
    - receiver: narrow
      matchers: ['team="a"', 'severity="page"']
    - receiver: broad
      matchers: ['team="a"']
"""
    )
    assert [u for _, u, _ in got] == [True, True, True]


def test_a_shadowed_routes_children_are_unusable_too():
    got = shapes(
        """
route:
  receiver: root
  routes:
    - receiver: all
    - receiver: later
      routes:
        - receiver: deep
          matchers: ['x="1"']
"""
    )
    assert [(r, u) for r, u, _ in got] == [
        ("root", False),
        ("all", True),
        ("later", False),
        ("deep", False),
    ]
    assert got[3][2] == SHADOW


def test_a_usable_channel_wins_over_an_unusable_duplicate():
    channels = parse_channels(
        """
route:
  receiver: root
  routes:
    - receiver: ops
      matchers: ['team="ops"', 'env=~"p.*"']
    - receiver: ops
      match: {team: ops}
"""
    )
    ops = [c for c in channels if c.receiver == "ops"]
    assert len(ops) == 1 and ops[0].usable and ops[0].path == "routes[1]"


def test_contradicting_labels_and_unreadable_matchers_have_their_own_reasons():
    channels = parse_channels(
        """
route:
  receiver: root
  routes:
    - receiver: a
      matchers: ['team="a"']
      routes:
        - receiver: b
          matchers: ['team="b"']
    - receiver: c
      matchers: ['not a matcher']
"""
    )
    by = {c.receiver: c for c in channels}
    assert by["b"].reason == "Its labels contradict the routes above it, so no alert can reach it."
    assert by["c"].reason == "OmniKrux couldn't read this route's matchers."
    assert not by["b"].usable and not by["c"].usable
