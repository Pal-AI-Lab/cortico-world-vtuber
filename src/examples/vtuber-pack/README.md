# 范例演出包

演出包 = 一个目录里的三份 JSON,是人格的表达空间。按三层找,后一层赢:

    <部署>/vtuber-pack/        部署者自己的覆盖(不进版本控制)
    bots/<bot>/vtuber-pack/    这个人格的演出资产(进版本控制)
    这一份                     两层都没有时的范例

`worlds.vtuber.packDir` 填了绝对路径就压过这三层(包在仓库外时用它)。

演出包对所有 Live2D 模型相同;模型差异只在模型目录的 `cortico.profile.json`
(见 [`../../models/LIVE2D-ADAPTATION.md`](../../models/LIVE2D-ADAPTATION.md))——那是**档案**,不是包。

| 文件 | 内容 |
|---|---|
| `params.json` | 语义参数集:每个参数的单位、量程(混音台按它钳位)、建议接到的 Live2D 参数、缺了会失去什么、可选的自检探针幅度。混音台内建行为写死用的十个参数(头部三轴、口型、眼睑、眼球四轴)必须声明,其余随包增删。 |
| `vocab.json` | `entries`:演出标签词 → 通道(gesture / pose / emotion / gaze / fx)→ clipId → 生命周期(pulse / state),可带 `intensity` 幅度档;`aliases`:别名 → 词。 |
| `clips.json` | `pulse`:一次性动作,逐参数关键帧 `[ms, value, ease?]`,首尾必须回 0;`sustain`:保持型姿态/表情的保持位;`gaze`:注视目标的眼球与头部落点。参数名只能是 `params.json` 里声明的,单位是语义单位(度、`[-1,1]`)。 |

规则由 [`../../pack.ts`](../../pack.ts) 在加载时逐字段校验:曲线只能驱动 params.json 里的参数,词不能重复,别名必须指向词表里的词,
每个词的 clipId 必须存在于对应的 clips 字典(fx 除外,它的 clipId 是模型档案 `fx` 表的键)。
控制台「动作调参」面板的「重载参数」从磁盘重读整个包;环境提示词里的标签表由 `entries` 渲染。
