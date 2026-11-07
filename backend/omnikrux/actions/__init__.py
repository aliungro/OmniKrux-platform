"""Actions: every change Omnikrux makes to a cluster, each a handler registered with the
pipeline (`omnikrux.actions.pipeline`) under its action name."""

from omnikrux.actions.delete import DeleteAction
from omnikrux.actions.edit import EditAction
from omnikrux.actions.nodes import CordonAction, DrainAction, UncordonAction
from omnikrux.actions.pipeline import register
from omnikrux.actions.workloads import RestartAction, RollbackAction, ScaleAction

register("edit", EditAction())
register("scale", ScaleAction())
register("restart", RestartAction())
register("rollback", RollbackAction())
register("delete", DeleteAction())
register("cordon", CordonAction())
register("uncordon", UncordonAction())
register("drain", DrainAction())
