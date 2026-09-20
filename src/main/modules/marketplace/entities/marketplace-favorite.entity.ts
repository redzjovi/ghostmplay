import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm'

@Entity('marketplace_favorites')
export class MarketplaceFavoriteEntity {
  @PrimaryGeneratedColumn() id!: number

  @Index({ unique: true })
  @Column({ type: 'text' }) name!: string

  @Column({ type: 'text', nullable: true }) q!: string | null

  // store as JSON arrays; simple-json works with sql.js
  @Column({ type: 'simple-json', nullable: true, name: 'equipment_types' })
  equipmentTypes!: string[] | null

  @Column({ type: 'simple-json', nullable: true, name: 'grade_effects' })
  gradeEffects!: string[] | null

  @Column({ type: 'text', default: 'recent', name: 'sort' })
  sort!: string

  @Column({ type: 'datetime', name: 'created_at', default: () => "datetime('now')" })
  createdAt!: Date

  @Column({ type: 'datetime', name: 'updated_at', default: () => "datetime('now')" })
  updatedAt!: Date
}
