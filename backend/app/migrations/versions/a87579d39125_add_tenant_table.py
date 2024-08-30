"""Add tenant table

Revision ID: a87579d39125
Revises: 9968344692b6
Create Date: 2024-08-30 15:48:48.496197

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = 'a87579d39125'
down_revision: Union[str, None] = '9968344692b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table('tenant',
    sa.Column('id', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
    sa.Column('name', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
    sa.Column('configuration', sa.JSON(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_tenant_name'), 'tenant', ['name'], unique=False)
    op.create_table('user',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.Column('tenant_id', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
    sa.Column('email', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
    sa.Column('full_name', sqlmodel.sql.sqltypes.AutoString(), nullable=True),
    sa.Column('role', sa.Enum('ADMIN', 'BASIC', name='userrole'), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['tenant_id'], ['tenant.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_user_email'), 'user', ['email'], unique=True)
    op.create_index(op.f('ix_user_tenant_id'), 'user', ['tenant_id'], unique=False)
    # ### end Alembic commands ###


def downgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_index(op.f('ix_user_tenant_id'), table_name='user')
    op.drop_index(op.f('ix_user_email'), table_name='user')
    op.drop_table('user')
    op.drop_index(op.f('ix_tenant_name'), table_name='tenant')
    op.drop_table('tenant')
    # ### end Alembic commands ###
