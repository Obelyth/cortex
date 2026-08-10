/**
 * Cortex second-brain map — canvas renderer.
 * Vendored verbatim from the design handoff (design_handoff_cortex_dashboard/
 * cortex-map-engine.js), itself a port of lib/atlas/template.ts: same ring bands, hex
 * packing, spin/spring/force passes, status graphics and label collision rejection,
 * re-tuned for the console. Local changes only:
 *   1. ESM export instead of a window global; the demo atlas is not carried.
 *   2. machineOK() accepts machine:"all" — buildAtlas() emits it; the handoff engine
 *      only knew "both", which is the exact filter bug the template already fixed once.
 *   3. select() expands the target's collapsed group first (the template's related-row
 *      behaviour) so drawer navigation never selects an invisible node.
 *   4. set() restores autofit on layout/machine changes, matching the template's buttons —
 *      otherwise one zoom leaves every later re-layout framed by a stale camera.
 *   5. Canvas fonts resolve --sans/--mono at construction: next/font registers the faces
 *      under hashed family names, so the handoff's literal families never matched.
 *   6. Status colors retuned to the app's tokens: disabled X #e0574f → #e8695f (the token
 *      scale retired the old red for AA contrast), disabled ring to its rgba dim, search
 *      match #fff → snow-bright #f6f8fb.
 * Design updates adopted 2026-08-05 (Cortex Dashboard Redesign · cortex-map-engine.js):
 *   7. Application nodes wear real vendor favicons in themed chips, sprite-fallback intact.
 *   8. Ring titles became leader-line callouts riding their ring's spin.
 *   9. resize() reads the layout box, not getBoundingClientRect() — an ancestor transform
 *      (the console's screen-entry animation) must not shrink the buffer under pick().
 * Client-side only: touches canvas, devicePixelRatio and rAF.
 */

  const TAU = Math.PI * 2;

  /* Two grounds. Dark is the product's own; light keeps the same structure but re-weights
     every steel so a 1px ring still reads on paper-white. */
  const THEMES = {
    dark: {
      knock: "#0f1318", label: "#e9edf2", labelDim: "#8b97a4",
      halo: "rgba(6,8,12,.92)", grid: "rgba(120,150,190,.045)",
      edge: "rgba(160,180,205,.12)", edgeBulk: "rgba(160,180,205,.028)",
      edgeDim: "rgba(160,180,205,.03)", edgeHot: "rgba(255,255,255,.62)",
      core: "#f6f8fb", coreGlow: "246,248,251", spoke: "rgba(246,248,251,.14)", match: "#f6f8fb",
      chip: "#161c25", chipRing: "rgba(174,184,196,.5)",
      layers: { applications: "#aeb8c4", routines: "#8b97a4", memory: "#1fbdd6", skills: "#677483" }
    },
    light: {
      knock: "#f4f6f9", label: "#1a212b", labelDim: "#5b6673",
      halo: "rgba(244,246,249,.94)", grid: "rgba(60,86,120,.075)",
      edge: "rgba(60,80,105,.20)", edgeBulk: "rgba(60,80,105,.06)",
      edgeDim: "rgba(60,80,105,.05)", edgeHot: "rgba(20,28,38,.62)",
      core: "#1a212b", coreGlow: "26,33,43", spoke: "rgba(26,33,43,.16)", match: "#0f1318",
      chip: "#ffffff", chipRing: "rgba(95,106,120,.45)",
      layers: { applications: "#5f6a78", routines: "#47525f", memory: "#0e8ba1", skills: "#7d8792" }
    }
  };

  /* Brand marks are the real 24×24 simple-icons paths; the four house glyphs are the
     hand-authored ones from lib/atlas/template.ts. All render on one 24-unit grid. */
  const SPRITES = {
    github: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
    vercel: "m12 1.608 12 20.784H0Z",
    supabase: "M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z",
    figma: "M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z",
    linear: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
    postgres: "M23.5594 14.7228a.5269.5269 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.0074-.2321-1.6533.3411-2.2935.1312-2.5256-.0191 1.342-2.0482 2.445-4.522 3.0411-6.8297.2714-1.0507.7982-3.5237.1222-4.7316a1.5641 1.5641 0 0 0-.1509-.235C21.6931.9086 19.8007.0248 17.5099.0005c-1.4947-.0158-2.7705.3461-3.1161.4794a9.449 9.449 0 0 0-.5159-.0816 8.044 8.044 0 0 0-1.3114-.1278c-1.1822-.0184-2.2038.2642-3.0498.8406-.8573-.3211-4.7888-1.645-7.2219.0788C.9359 2.1526.3086 3.8733.4302 6.3043c.0409.818.5069 3.334 1.2423 5.7436.4598 1.5065.9387 2.7019 1.4334 3.582.553.9942 1.1259 1.5933 1.7143 1.7895.4474.1491 1.1327.1441 1.8581-.7279.8012-.9635 1.5903-1.8258 1.9446-2.2069.4351.2355.9064.3625 1.39.3772a.0569.0569 0 0 0 .0004.0041 11.0312 11.0312 0 0 0-.2472.3054c-.3389.4302-.4094.5197-1.5002.7443-.3102.064-1.1344.2339-1.1464.8115-.0025.1224.0329.2309.0919.3268.2269.4231.9216.6097 1.015.6331 1.3345.3335 2.5044.092 3.3714-.6787-.017 2.231.0775 4.4174.3454 5.0874.2212.5529.7618 1.9045 2.4692 1.9043.2505 0 .5263-.0291.8296-.0941 1.7819-.3821 2.5557-1.1696 2.855-2.9059.1503-.8707.4016-2.8753.5388-4.1012.0169-.0703.0357-.1207.057-.1362.0007-.0005.0697-.0471.4272.0307a.3673.3673 0 0 0 .0443.0068l.2539.0223.0149.001c.8468.0384 1.9114-.1426 2.5312-.4308.6438-.2988 1.8057-1.0323 1.5951-1.6698zM2.371 11.8765c-.7435-2.4358-1.1779-4.8851-1.2123-5.5719-.1086-2.1714.4171-3.6829 1.5623-4.4927 1.8367-1.2986 4.8398-.5408 6.108-.13-.0032.0032-.0066.0061-.0098.0094-2.0238 2.044-1.9758 5.536-1.9708 5.7495-.0002.0823.0066.1989.0162.3593.0348.5873.0996 1.6804-.0735 2.9184-.1609 1.1504.1937 2.2764.9728 3.0892.0806.0841.1648.1631.2518.2374-.3468.3714-1.1004 1.1926-1.9025 2.1576-.5677.6825-.9597.5517-1.0886.5087-.3919-.1307-.813-.5871-1.2381-1.3223-.4796-.839-.9635-2.0317-1.4155-3.5126zm6.0072 5.0871c-.1711-.0428-.3271-.1132-.4322-.1772.0889-.0394.2374-.0902.4833-.1409 1.2833-.2641 1.4815-.4506 1.9143-1.0002.0992-.126.2116-.2687.3673-.4426a.3549.3549 0 0 0 .0737-.1298c.1708-.1513.2724-.1099.4369-.0417.156.0646.3078.26.3695.4752.0291.1016.0619.2945-.0452.4444-.9043 1.2658-2.2216 1.2494-3.1676 1.0128zm2.094-3.988-.0525.141c-.133.3566-.2567.6881-.3334 1.003-.6674-.0021-1.3168-.2872-1.8105-.8024-.6279-.6551-.9131-1.5664-.7825-2.5004.1828-1.3079.1153-2.4468.079-3.0586-.005-.0857-.0095-.1607-.0122-.2199.2957-.2621 1.6659-.9962 2.6429-.7724.4459.1022.7176.4057.8305.928.5846 2.7038.0774 3.8307-.3302 4.7363-.084.1866-.1633.3629-.2311.5454zm7.3637 4.5725c-.0169.1768-.0358.376-.0618.5959l-.146.4383a.3547.3547 0 0 0-.0182.1077c-.0059.4747-.054.6489-.115.8693-.0634.2292-.1353.4891-.1794 1.0575-.11 1.4143-.8782 2.2267-2.4172 2.5565-1.5155.3251-1.7843-.4968-2.0212-1.2217a6.5824 6.5824 0 0 0-.0769-.2266c-.2154-.5858-.1911-1.4119-.1574-2.5551.0165-.5612-.0249-1.9013-.3302-2.6462.0044-.2932.0106-.5909.019-.8918a.3529.3529 0 0 0-.0153-.1126 1.4927 1.4927 0 0 0-.0439-.208c-.1226-.4283-.4213-.7866-.7797-.9351-.1424-.059-.4038-.1672-.7178-.0869.067-.276.1831-.5875.309-.9249l.0529-.142c.0595-.16.134-.3257.213-.5012.4265-.9476 1.0106-2.2453.3766-5.1772-.2374-1.0981-1.0304-1.6343-2.2324-1.5098-.7207.0746-1.3799.3654-1.7088.5321a5.6716 5.6716 0 0 0-.1958.1041c.0918-1.1064.4386-3.1741 1.7357-4.4823a4.0306 4.0306 0 0 1 .3033-.276.3532.3532 0 0 0 .1447-.0644c.7524-.5706 1.6945-.8506 2.802-.8325.4091.0067.8017.0339 1.1742.081 1.939.3544 3.2439 1.4468 4.0359 2.3827.8143.9623 1.2552 1.9315 1.4312 2.4543-1.3232-.1346-2.2234.1268-2.6797.779-.9926 1.4189.543 4.1729 1.2811 5.4964.1353.2426.2522.4522.2889.5413.2403.5825.5515.9713.7787 1.2552.0696.087.1372.1714.1885.245-.4008.1155-1.1208.3825-1.0552 1.717-.0123.1563-.0423.4469-.0834.8148-.0461.2077-.0702.4603-.0994.7662zm.8905-1.6211c-.0405-.8316.2691-.9185.5967-1.0105a2.8566 2.8566 0 0 0 .135-.0406 1.202 1.202 0 0 0 .1342.103c.5703.3765 1.5823.4213 3.0068.1344-.2016.1769-.5189.3994-.9533.6011-.4098.1903-1.0957.333-1.7473.3636-.7197.0336-1.0859-.0807-1.1721-.151zm.5695-9.2712c-.0059.3508-.0542.6692-.1054 1.0017-.055.3576-.112.7274-.1264 1.1762-.0142.4368.0404.8909.0932 1.3301.1066.887.216 1.8003-.2075 2.7014a3.5272 3.5272 0 0 1-.1876-.3856c-.0527-.1276-.1669-.3326-.3251-.6162-.6156-1.1041-2.0574-3.6896-1.3193-4.7446.3795-.5427 1.3408-.5661 2.1781-.463zm.2284 7.0137a12.3762 12.3762 0 0 0-.0853-.1074l-.0355-.0444c.7262-1.1995.5842-2.3862.4578-3.4385-.0519-.4318-.1009-.8396-.0885-1.2226.0129-.4061.0666-.7543.1185-1.0911.0639-.415.1288-.8443.1109-1.3505.0134-.0531.0188-.1158.0118-.1902-.0457-.4855-.5999-1.938-1.7294-3.253-.6076-.7073-1.4896-1.4972-2.6889-2.0395.5251-.1066 1.2328-.2035 2.0244-.1859 2.0515.0456 3.6746.8135 4.8242 2.2824a.908.908 0 0 1 .0667.1002c.7231 1.3556-.2762 6.2751-2.9867 10.5405zm-8.8166-6.1162c-.025.1794-.3089.4225-.6211.4225a.5821.5821 0 0 1-.0809-.0056c-.1873-.026-.3765-.144-.5059-.3156-.0458-.0605-.1203-.178-.1055-.2844.0055-.0401.0261-.0985.0925-.1488.1182-.0894.3518-.1226.6096-.0867.3163.0441.6426.1938.6113.4186zm7.9305-.4114c.0111.0792-.049.201-.1531.3102-.0683.0717-.212.1961-.4079.2232a.5456.5456 0 0 1-.075.0052c-.2935 0-.5414-.2344-.5607-.3717-.024-.1765.2641-.3106.5611-.352.297-.0414.6111.0088.6356.1851z",
    chrome: "M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728Z",
    files: "M12.367 2.453a.822.822 0 0 0-.576.238L.241 14.213a.822.822 0 0 0-.241.584v.066c0-.323.209-.608.516-.709l7.275-2.318a2.437 2.437 0 0 0 1.584-1.592l2.318-7.267a.757.757 0 0 1 .719-.524zM0 14.863v5.047c0 .904.733 1.637 1.637 1.637h20.726c.904 0 1.637-.733 1.637-1.637V4.09c0-.904-.733-1.637-1.637-1.637h-9.951v.5l.088 9.861c.01 1.175-.962 2.14-2.137 2.14L0 14.862zM12 3.66l-2.148 6.735v.001a2.94 2.94 0 0 1-1.909 1.916l-6.716 2.141h9.136c.905 0 1.638-.734 1.637-1.639zm-10.363.975c-.905 0-1.638.734-1.637 1.638v7.473l9.135-9.111Z",
    terminal: "M1.846 0A1.841 1.841 0 000 1.846v18.463c0 1.022.823 1.845 1.846 1.845h20.308A1.841 1.841 0 0024 20.31V1.846A1.841 1.841 0 0022.154 0H1.846zm0 .924h20.308c.512 0 .922.41.922.922v18.463c0 .511-.41.921-.922.921H1.846a.919.919 0 01-.922-.921V1.846c0-.512.41-.922.922-.922zm0 .922v18.463h20.308V1.846H1.846zm1.845 2.14l3.235 1.758v.836L3.69 8.477V7.385l2.243-1.207v-.033L3.69 5.076v-1.09zM7.846 9.23h3.693v.924H7.846V9.23zM0 21.736v.418C0 23.177.823 24 1.846 24h20.308A1.841 1.841 0 0024 22.154v-.418a2.334 2.334 0 01-1.846.918H1.846A2.334 2.334 0 010 21.736Z",
    bash: "M21.038,4.9l-7.577-4.498C13.009,0.134,12.505,0,12,0c-0.505,0-1.009,0.134-1.462,0.403L2.961,4.9 C2.057,5.437,1.5,6.429,1.5,7.503v8.995c0,1.073,0.557,2.066,1.462,2.603l7.577,4.497C10.991,23.866,11.495,24,12,24 c0.505,0,1.009-0.134,1.461-0.402l7.577-4.497c0.904-0.537,1.462-1.529,1.462-2.603V7.503C22.5,6.429,21.943,5.437,21.038,4.9z M15.17,18.946l0.013,0.646c0.001,0.078-0.05,0.167-0.111,0.198l-0.383,0.22c-0.061,0.031-0.111-0.007-0.112-0.085L14.57,19.29 c-0.328,0.136-0.66,0.169-0.872,0.084c-0.04-0.016-0.057-0.075-0.041-0.142l0.139-0.584c0.011-0.046,0.036-0.092,0.069-0.121 c0.012-0.011,0.024-0.02,0.036-0.026c0.022-0.011,0.043-0.014,0.062-0.006c0.229,0.077,0.521,0.041,0.802-0.101 c0.357-0.181,0.596-0.545,0.592-0.907c-0.003-0.328-0.181-0.465-0.613-0.468c-0.55,0.001-1.064-0.107-1.072-0.917 c-0.007-0.667,0.34-1.361,0.889-1.8l-0.007-0.652c-0.001-0.08,0.048-0.168,0.111-0.2l0.37-0.236 c0.061-0.031,0.111,0.007,0.112,0.087l0.006,0.653c0.273-0.109,0.511-0.138,0.726-0.088c0.047,0.012,0.067,0.076,0.048,0.151 l-0.144,0.578c-0.011,0.044-0.036,0.088-0.065,0.116c-0.012,0.012-0.025,0.021-0.038,0.028c-0.019,0.01-0.038,0.013-0.057,0.009 c-0.098-0.022-0.332-0.073-0.699,0.113c-0.385,0.195-0.52,0.53-0.517,0.778c0.003,0.297,0.155,0.387,0.681,0.396 c0.7,0.012,1.003,0.318,1.01,1.023C16.105,17.747,15.736,18.491,15.17,18.946z M19.143,17.859c0,0.06-0.008,0.116-0.058,0.145 l-1.916,1.164c-0.05,0.029-0.09,0.004-0.09-0.056v-0.494c0-0.06,0.037-0.093,0.087-0.122l1.887-1.129 c0.05-0.029,0.09-0.004,0.09,0.056V17.859z M20.459,6.797l-7.168,4.427c-0.894,0.523-1.553,1.109-1.553,2.187v8.833 c0,0.645,0.26,1.063,0.66,1.184c-0.131,0.023-0.264,0.039-0.398,0.039c-0.42,0-0.833-0.114-1.197-0.33L3.226,18.64 c-0.741-0.44-1.201-1.261-1.201-2.142V7.503c0-0.881,0.46-1.702,1.201-2.142l7.577-4.498c0.363-0.216,0.777-0.33,1.197-0.33 c0.419,0,0.833,0.114,1.197,0.33l7.577,4.498c0.624,0.371,1.046,1.013,1.164,1.732C21.686,6.557,21.12,6.411,20.459,6.797z",
    markdown: "M22.27 19.385H1.73A1.73 1.73 0 010 17.655V6.345a1.73 1.73 0 011.73-1.73h20.54A1.73 1.73 0 0124 6.345v11.308a1.73 1.73 0 01-1.73 1.731zM5.769 15.923v-4.5l2.308 2.885 2.307-2.885v4.5h2.308V8.078h-2.308l-2.307 2.885-2.308-2.885H3.46v7.847zM21.232 12h-2.309V8.077h-2.307V12h-2.308l3.461 4.039z",
    claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    apple: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
    slack: "M 6.7 5.1 L 11.7 5.1 A 2.3 2.3 0 0 1 11.7 9.7 L 6.7 9.7 A 2.3 2.3 0 0 1 6.7 5.1 Z M 9.7 12.3 L 9.7 17.3 A 2.3 2.3 0 0 1 5.1 17.3 L 5.1 12.3 A 2.3 2.3 0 0 1 9.7 12.3 Z M 12.3 14.3 L 17.3 14.3 A 2.3 2.3 0 0 1 17.3 18.9 L 12.3 18.9 A 2.3 2.3 0 0 1 12.3 14.3 Z M 18.9 6.7 L 18.9 11.7 A 2.3 2.3 0 0 1 14.3 11.7 L 14.3 6.7 A 2.3 2.3 0 0 1 18.9 6.7 Z",
    playwright: "M12 2.8 C17.2 2.8 20.2 5 20.2 9.2 C20.2 15.4 16.4 21.4 12 21.4 C7.6 21.4 3.8 15.4 3.8 9.2 C3.8 5 6.8 2.8 12 2.8 Z M7.2 9.9 A1.9 1.4 0 1 0 11 9.9 A1.9 1.4 0 1 0 7.2 9.9 Z M13 9.9 A1.9 1.4 0 1 0 16.8 9.9 A1.9 1.4 0 1 0 13 9.9 Z M8.6 14.6 C10.2 15.8 13.8 15.8 15.4 14.6 C14.9 18.6 9.1 18.6 8.6 14.6 Z",
    cortex: "M9 12A3 3 0 1 0 15 12A3 3 0 1 0 9 12ZM9.6 4.2A2.4 2.4 0 1 0 14.4 4.2A2.4 2.4 0 1 0 9.6 4.2ZM3 17.4A2.4 2.4 0 1 0 7.8 17.4A2.4 2.4 0 1 0 3 17.4ZM16.2 17.4A2.4 2.4 0 1 0 21 17.4A2.4 2.4 0 1 0 16.2 17.4ZM11 12L13 12L13 4.2L11 4.2ZM4.77 16.63L6.03 18.17L12.63 12.77L11.37 11.23ZM12.63 11.23L11.37 12.77L17.97 18.17L19.23 16.63Z",
    "sequential-thinking": "M4.5 18.8L6.3 18.8L6.3 5.2L4.5 5.2ZM2.9 5.2A2.5 2.5 0 1 0 7.9 5.2A2.5 2.5 0 1 0 2.9 5.2ZM2.9 12A2.5 2.5 0 1 0 7.9 12A2.5 2.5 0 1 0 2.9 12ZM2.9 18.8A2.5 2.5 0 1 0 7.9 18.8A2.5 2.5 0 1 0 2.9 18.8ZM9.8 3.9L21.2 3.9L21.2 6.5L9.8 6.5ZM9.8 10.7L21.2 10.7L21.2 13.3L9.8 13.3ZM9.8 17.5L21.2 17.5L21.2 20.1L9.8 20.1Z",
    plug: "M8.4 2L10.2 2L10.2 7.2L8.4 7.2ZM13.8 2L15.6 2L15.6 7.2L13.8 7.2ZM6.2 7L17.8 7L17.8 12A5.8 5.8 0 0 1 6.2 12ZM11.1 16.6L12.9 16.6L12.9 21.6L11.1 21.6Z",
    /* House glyphs for the layers that have no vendor: an agent, a slash command, a hook,
       a skill card and a person. Same 24-unit grid, same optical weight as the brand marks. */
    agent: "M12 1.6 14.9 3.3 14.9 6.6 12 8.3 9.1 6.6 9.1 3.3ZM4.2 10.1 12 14.6 19.8 10.1 19.8 11.9 12 16.4 4.2 11.9ZM4.2 14.6 12 19.1 19.8 14.6 19.8 16.4 12 20.9 4.2 16.4Z",
    command: "M3.4 4.2 5.1 2.6 12.4 9.6 12.4 11.2 5.1 18.2 3.4 16.6 9.6 10.4ZM12.4 17.4 21.2 17.4 21.2 19.8 12.4 19.8Z",
    hook: "M9.1 14.9 14.9 9.1 16.6 10.8 10.8 16.6ZM6.7 12.5 4.6 14.6A4 4 0 0 0 10.2 20.2L12.3 18.1 10.6 16.4 8.5 18.5A1.6 1.6 0 0 1 6.3 16.3L8.4 14.2ZM17.3 11.5 19.4 9.4A4 4 0 0 0 13.8 3.8L11.7 5.9 13.4 7.6 15.5 5.5A1.6 1.6 0 0 1 17.7 7.7L15.6 9.8Z",
    skill: "M4.6 3.2 12 3.2 12 20.8 4.6 20.8A1.4 1.4 0 0 1 3.2 19.4L3.2 4.6A1.4 1.4 0 0 1 4.6 3.2ZM12 3.2 19.4 3.2A1.4 1.4 0 0 1 20.8 4.6L20.8 19.4A1.4 1.4 0 0 1 19.4 20.8L12 20.8ZM14.2 7.4 18.6 7.4 18.6 9.2 14.2 9.2ZM14.2 11.2 18.6 11.2 18.6 13 14.2 13Z",
    user: "M12 3.2A4.3 4.3 0 1 1 12 11.8A4.3 4.3 0 1 1 12 3.2ZM3.6 21.4C3.6 16.9 7.4 13.6 12 13.6C16.6 13.6 20.4 16.9 20.4 21.4Z"
  };
  /* Optical trim per mark: simple-icons fill their 24-box to different densities, so a
     single scale makes Vercel's triangle shout and GitHub's disc whisper. */
  const TRIM = { vercel: 0.86, linear: 0.94, supabase: 0.9, claude: 0.94, apple: 0.92, markdown: 1.04, terminal: 1.02, bash: 0.98, plug: 0.94, cortex: 1.02 };
  /* Routine and skill groups get a glyph by what they ARE, not who made them. */
  const GROUP_GLYPH = {
    agents: "agent", commands: "command", hooks: "hook",
    user: "user", plugin: "plug", anthropic: "claude", repo: "github"
  };
  const ALIASES = [
    ["github", "github"], ["vercel", "vercel"], ["supabase", "supabase"], ["figma", "figma"],
    ["slack", "slack"], ["linear", "linear"], ["chrome", "chrome"], ["postgres", "postgres"],
    ["playwright", "playwright"], ["cortex", "cortex"], ["filesystem", "files"],
    ["sequential", "sequential-thinking"], ["terminal", "terminal"], ["shell", "bash"],
    ["claude", "claude"], ["anthropic", "claude"], ["markdown", "markdown"], ["apple", "apple"]
  ];

  /* Sprite cache: every mark is rasterised once per (mark, pixel size, tint) and blitted
     thereafter. Filling a 5KB Path2D per node per frame is what makes canvas maps stutter. */
  const spriteCache = new Map();
  /* Real favicons for vendor connectors (same source as the design's provider list); house
     tools keep the monochrome glyphs. Loaded once, drawn when ready — the sprite fallback
     covers the first frames and any offline failure. */
  const FAVICON = {
    github: "github.com", vercel: "vercel.com", supabase: "supabase.com", figma: "figma.com",
    slack: "slack.com", linear: "linear.app", chrome: "google.com", postgres: "postgresql.org",
    playwright: "playwright.dev", claude: "anthropic.com", apple: "apple.com"
  };
  const favCache = new Map();
  function favicon(key) {
    if (!FAVICON[key]) return null;
    let f = favCache.get(key);
    if (!f) {
      f = { img: new Image(), ok: false };
      f.img.onload = () => (f.ok = true);
      f.img.src = "https://www.google.com/s2/favicons?domain=" + FAVICON[key] + "&sz=64";
      favCache.set(key, f);
    }
    return f.ok ? f.img : null;
  }

  function sprite(key, px, tint) {
    const ck = key + "|" + px + "|" + tint;
    let c = spriteCache.get(ck);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = px; c.height = px;
    const g = c.getContext("2d");
    const k = (px / 24) * (TRIM[key] || 1);
    g.translate(px / 2, px / 2);
    g.scale(k, k);
    g.translate(-12, -12);
    g.fillStyle = tint;
    g.fill(new Path2D(SPRITES[key] || SPRITES.plug));
    spriteCache.set(ck, c);
    return c;
  }

  class CortexMap {
    constructor(canvas, data, opts) {
      opts = opts || {};
      this.cv = canvas;
      this.ctx = canvas.getContext("2d");
      this.onLegend = opts.onLegend || function () {};
      this.onSelect = opts.onSelect || function () {};
      this.D = data;

      this.S = {
        layout: "rings", spin: 0.3, spring: 0, sizeK: 1,
        labels: true, edges: true, hex: true,
        machine: "all", query: "", sel: null, hover: null,
        offLayers: new Set(), expanded: new Set(),
        cam: { x: 0, y: 0, k: 1 }, w: 0, h: 0, dpr: 1, t: 0, autofit: true
      };

      this.T = THEMES[opts.theme === "light" ? "light" : "dark"];

      // Local change 5: next/font registers the brand faces under hashed family names, so the
      // handoff's literal families never resolve — read the real stacks off the CSS variables.
      let sans = "", mono = "";
      try {
        const cs = getComputedStyle(canvas.ownerDocument.documentElement);
        sans = cs.getPropertyValue("--sans").trim();
        mono = cs.getPropertyValue("--mono").trim();
      } catch { /* headless: keep the literal fallbacks */ }
      this.SANS = sans || "'Hanken Grotesk',system-ui,sans-serif";
      this.MONO = mono || "'JetBrains Mono',ui-monospace,Menlo,monospace";
      this.LAYER = { core: { key: "core", label: "CORE", color: this.T.core, ring: 0 } };
      data.layers.forEach((l) => (this.LAYER[l.key] = Object.assign({}, l, { color: this.T.layers[l.key] || l.color })));
      this.ORDER = data.layers.slice().sort((a, b) => a.ring - b.ring).map((l) => l.key);

      this.N = data.nodes.map((n) => Object.assign({}, n, { x: 0, y: 0, tx: 0, ty: 0, vx: 0, vy: 0, r: 4, held: false }));
      this.BY = new Map(this.N.map((n) => [n.id, n]));
      this.CENTER = data.center ? this.BY.get(data.center) : null;
      if (this.CENTER) this.CENTER.isCenter = true;

      this.GROUPS = new Map();
      for (const n of this.N) {
        if (n.isCenter) continue;
        const k = n.layer + "\u0000" + n.group;
        if (!this.GROUPS.has(k)) this.GROUPS.set(k, { layer: n.layer, group: n.group, members: [] });
        this.GROUPS.get(k).members.push(n);
      }
      for (const [k, g] of this.GROUPS) {
        const big = g.members.length > 14 || (g.layer === "skills" && g.group !== "user");
        if (!big) this.S.expanded.add(k);
      }

      this.HUBS = new Map();
      for (const [k, g] of this.GROUPS) {
        this.HUBS.set(k, {
          id: "hub\u0000" + k, isHub: true, hubKey: k, layer: g.layer, group: g.group,
          label: g.group, description: g.members.length + " items in " + g.group,
          detail: g.members.length + " \u00d7 " + g.layer, weight: g.members.length,
          status: "active", machine: "both", members: g.members,
          x: 0, y: 0, tx: 0, ty: 0, vx: 0, vy: 0, r: 6, held: false
        });
      }

      this.EDGES = data.edges
        .map((e) => ({ s: this.BY.get(e.source), t: this.BY.get(e.target), kind: e.kind }))
        .filter((e) => e.s && e.t);
      this.ADJ = new Map(this.N.map((n) => [n.id, new Set()]));
      for (const e of this.EDGES) { this.ADJ.get(e.s.id).add(e.t.id); this.ADJ.get(e.t.id).add(e.s.id); }

      this.BAND = {};
      const RADII = [190, 274, 348, 406, 462];
      this.ORDER.forEach((key, i) => (this.BAND[key] = RADII[i] || 150 + i * 118));
      this.iconCache = new Map();
      this.VIS = [];

      this._bind();
      this.resize();
      this.rebuild();
      this._raf = requestAnimationFrame(() => this.frame());
    }

    /* ---------------------------------------------------------- lifecycle */
    destroy() {
      cancelAnimationFrame(this._raf);
      if (this._ro) this._ro.disconnect();
      this._off.forEach((f) => f());
    }

    resize() {
      // The LAYOUT box, never getBoundingClientRect(): an ancestor transform (the console's
      // screen-entry animation scales the whole sheet) would otherwise shrink the buffer and
      // put pick() into a different coordinate space than the pointer events it tests.
      const w = this.cv.clientWidth || this.cv.offsetWidth;
      const h = this.cv.clientHeight || this.cv.offsetHeight;
      this.S.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.S.w = w; this.S.h = h;
      this.cv.width = Math.max(1, Math.round(w * this.S.dpr));
      this.cv.height = Math.max(1, Math.round(h * this.S.dpr));
      this.ctx.setTransform(this.S.dpr, 0, 0, this.S.dpr, 0, 0);
    }

    /* ------------------------------------------------------------ control */
    setTheme(name) {
      const t = THEMES[name === "light" ? "light" : "dark"];
      if (t === this.T) return;
      this.T = t;
      this.LAYER.core.color = t.core;
      for (const k in t.layers) if (this.LAYER[k]) this.LAYER[k].color = t.layers[k];
      spriteCache.clear();
      this.emit();
    }

    set(patch) {
      let structural = false;
      for (const k in patch) {
        if (k === "machine") structural = true;
        if (k === "layout" || k === "machine") this.S.autofit = true;
        this.S[k] = patch[k];
      }
      if (structural) this.rebuild();
      this.emit();
    }
    toggleLayer(key) {
      this.S.offLayers.has(key) ? this.S.offLayers.delete(key) : this.S.offLayers.add(key);
      this.S.autofit = true;
      this.rebuild(); this.emit();
    }
    toggleGroup(k) {
      this.S.expanded.has(k) ? this.S.expanded.delete(k) : this.S.expanded.add(k);
      this.rebuild(); this.emit();
    }
    expandAll() { for (const k of this.GROUPS.keys()) this.S.expanded.add(k); this.rebuild(); this.emit(); }
    collapseAll() { this.S.expanded.clear(); this.rebuild(); this.emit(); }
    select(id) {
      const n = this.BY.get(id);
      if (!n) return;
      const k = n.layer + "\u0000" + n.group;
      if (!n.isHub && !n.isCenter && this.GROUPS.has(k) && !this.S.expanded.has(k)) {
        this.S.expanded.add(k); this.rebuild(); this.emit();
      }
      this.openDetail(n);
    }
    clearSelection() { this.S.sel = null; this.onSelect(null); }

    emit() {
      const rows = this.ORDER.map((key) => {
        const L = this.LAYER[key];
        const groups = [];
        let count = 0;
        for (const [k, g] of this.GROUPS) {
          if (g.layer !== key) continue;
          const n = g.members.filter((m) => this.machineOK(m)).length;
          if (!n) continue;
          count += n;
          groups.push({ key: k, group: g.group, count: n, expanded: this.S.expanded.has(k) });
        }
        groups.sort((a, b) => b.count - a.count);
        return { key, label: L.label, color: L.color, count, groups, off: this.S.offLayers.has(key) };
      });
      this.onLegend({ rows, total: this.VIS.length });
    }

    /* -------------------------------------------------------- visibility */
    machineOK(n) {
      if (this.S.machine === "all") return true;
      if (n.isHub) return n.members.some((m) => this.machineOK(m));
      return n.machine === this.S.machine || n.machine === "both" || n.machine === "all";
    }
    layerOK(n) { return !this.S.offLayers.has(n.layer); }

    rebuild() {
      const out = [];
      if (this.CENTER && this.layerOK(this.CENTER)) out.push(this.CENTER);
      for (const [k, g] of this.GROUPS) {
        if (!this.layerOK(g.members[0])) continue;
        if (this.S.expanded.has(k)) {
          for (const m of g.members) if (this.machineOK(m)) out.push(m);
        } else {
          const h = this.HUBS.get(k);
          if (this.machineOK(h)) out.push(h);
        }
      }
      this.VIS = out;
      this.layoutRings();
      this.layoutHex();
    }

    /* ------------------------------------------------------------ layouts */
    layoutRings() {
      if (this.CENTER) { this.CENTER.tx = 0; this.CENTER.ty = 0; }
      for (const key of this.ORDER) {
        const inLayer = this.VIS.filter((n) => n.layer === key && !n.isCenter);
        if (!inLayer.length) continue;
        const byGroup = new Map();
        for (const n of inLayer) {
          if (!byGroup.has(n.group)) byGroup.set(n.group, []);
          byGroup.get(n.group).push(n);
        }
        const groups = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length);
        const share = groups.map(([, m]) => Math.sqrt(m.length) + 0.6);
        const total = share.reduce((a, b) => a + b, 0);
        const TOPGAP = 0.62;
        const usable = TAU - TOPGAP;
        let a0 = -Math.PI / 2 + TOPGAP / 2;
        groups.forEach(([, members], gi) => {
          const span = (share[gi] / total) * usable;
          const R = this.BAND[key];
          const pad = Math.min(span * 0.16, 0.09);
          const s = a0 + pad, e = a0 + span - pad;
          members.forEach((n, i) => {
            const t = members.length === 1 ? 0.5 : i / (members.length - 1);
            const rows = Math.max(1, Math.ceil(members.length / 26));
            const row = rows === 1 ? 0 : (i % rows) - (rows - 1) / 2;
            n.ang = s + (e - s) * t;
            n.rad = R + row * 21;
          });
          a0 += span;
        });
      }
    }

    hexSlots(n) {
      const out = [{ q: 0, r: 0 }];
      const dirs = [[-1, 1], [-1, 0], [0, -1], [1, -1], [1, 0], [0, 1]];
      let ring = 1;
      while (out.length < n) {
        let q = ring, r = 0;
        for (const [dq, dr] of dirs) for (let i = 0; i < ring; i++) { out.push({ q, r }); q += dq; r += dr; }
        ring++;
      }
      return out.slice(0, n);
    }
    layoutHex() {
      const buckets = new Map();
      for (const n of this.VIS) {
        if (n.isCenter) continue;
        const k = n.isHub ? n.hubKey : n.layer + "\u0000" + n.group;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(n);
      }
      const keys = [...buckets.keys()].sort((a, b) => buckets.get(b).length - buckets.get(a).length);
      const slots = this.hexSlots(keys.length + 1);
      const S0 = 112;
      if (this.CENTER) { this.CENTER.hx = 0; this.CENTER.hy = 0; }
      keys.forEach((k, i) => {
        const { q, r } = slots[i + 1];
        const cx = S0 * Math.sqrt(3) * (q + r / 2), cy = S0 * 1.5 * r;
        const members = buckets.get(k);
        if (members.length === 1) { members[0].hx = cx; members[0].hy = cy; return; }
        members.forEach((n, j) => {
          const perRing = 9, lap = Math.floor(j / perRing), idx = j % perRing;
          const rad = 30 + lap * 24, a = (idx / perRing) * TAU + lap * 0.5;
          n.hx = cx + Math.cos(a) * rad;
          n.hy = cy + Math.sin(a) * rad;
        });
      });
    }

    /**
     * One size ramp for the whole map. Applications are uniform because they are peers
     * carrying a logo — varying them by "weight" makes a sprite sheet look like a bug —
     * and every other layer is sized so its labels clear at the default zoom.
     */
    sizeOf(n) {
      let w;
      if (n.isCenter) w = 20;
      else if (n.isHub) w = Math.max(11, Math.min(26, Math.sqrt(n.members.length) * 3.4 + 6));
      else if (n.layer === "applications") w = 13;
      else if (n.layer === "routines") w = 11;
      else if (n.layer === "memory") w = 4.2 + Math.sqrt(Math.max(0, n.weight)) * 1.7;
      else if (n.layer === "skills") w = 9;
      else w = 3.4 + Math.sqrt(Math.max(0, n.weight)) * 1.1;
      return w * this.S.sizeK;
    }

    /* ------------------------------------------------------------ physics */
    step(dt) {
      const S = this.S;
      S.t += dt;
      const spinRate = S.spin * 0.00022;
      for (const n of this.VIS) {
        n.r += (this.sizeOf(n) - n.r) * 0.2;
        if (n.isCenter) { n.tx = 0; n.ty = 0; }
        else if (n.ang !== undefined) {
          const a = n.ang + S.t * spinRate * (n.layer === "applications" ? 0.6 : 1);
          n.tx = Math.cos(a) * n.rad;
          n.ty = Math.sin(a) * n.rad;
        }
      }
      if (S.layout === "hex") {
        for (const n of this.VIS) {
          if (n.held) continue;
          n.x += ((n.hx || 0) - n.x) * 0.09;
          n.y += ((n.hy || 0) - n.y) * 0.09;
        }
        if (S.spring > 0) this.springPass(S.spring * 0.35);
      } else if (S.layout === "rings") {
        for (const n of this.VIS) {
          if (n.held) continue;
          n.x += (n.tx - n.x) * 0.085;
          n.y += (n.ty - n.y) * 0.085;
        }
        if (S.spring > 0) this.springPass(S.spring * 0.35);
      } else this.forcePass();
    }

    springPass(k) {
      for (const e of this.EDGES) {
        const s = e.s.__proxy || e.s, t = e.t.__proxy || e.t;
        if (!s.__vis || !t.__vis) continue;
        const dx = t.x - s.x, dy = t.y - s.y, d = Math.hypot(dx, dy) || 0.01;
        const f = (d - 150) * k * 0.01;
        if (!s.held) { s.x += (dx / d) * f; s.y += (dy / d) * f; }
        if (!t.held) { t.x -= (dx / d) * f; t.y -= (dy / d) * f; }
      }
    }

    forcePass() {
      const V = this.VIS, n = V.length;
      for (let i = 0; i < n; i++) {
        const a = V[i];
        for (let j = i + 1; j < n; j++) {
          const b = V[j];
          let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
          if (d2 > 160000) continue;
          if (d2 < 1e-4) { dx = (i - j) * 0.05 || 0.05; dy = 0.05; d2 = 0.01; }
          const d = Math.sqrt(d2), f = 900 / d2, ux = dx / d, uy = dy / d;
          a.vx -= ux * f; a.vy -= uy * f; b.vx += ux * f; b.vy += uy * f;
          const min = a.r + b.r + 6;
          if (d < min) { const p = (min - d) * 0.4; a.vx -= ux * p; a.vy -= uy * p; b.vx += ux * p; b.vy += uy * p; }
        }
      }
      for (const e of this.EDGES) {
        const s = e.s.__proxy || e.s, t = e.t.__proxy || e.t;
        if (!s.__vis || !t.__vis || s === t) continue;
        const dx = t.x - s.x, dy = t.y - s.y, d = Math.hypot(dx, dy) || 0.01;
        const f = (d - 118) * 0.014, ux = dx / d, uy = dy / d;
        s.vx += ux * f; s.vy += uy * f; t.vx -= ux * f; t.vy -= uy * f;
      }
      for (const a of V) {
        const want = a.isCenter ? 0 : (this.BAND[a.layer] || 300) * 0.92;
        const d = Math.hypot(a.x, a.y) || 0.01;
        const f = (d - want) * 0.01;
        a.vx -= (a.x / d) * f; a.vy -= (a.y / d) * f;
        if (a.held) { a.vx = 0; a.vy = 0; continue; }
        a.vx *= 0.84; a.vy *= 0.84;
        const sp = Math.hypot(a.vx, a.vy);
        if (sp > 13) { a.vx = (a.vx / sp) * 13; a.vy = (a.vy / sp) * 13; }
        a.x += a.vx; a.y += a.vy;
      }
    }

    fit() {
      if (!this.VIS.length) return;
      let m = 0;
      for (const n of this.VIS) m = Math.max(m, Math.hypot(n.x, n.y) + n.r);
      m = Math.max(m, 160);
      const k = Math.min(2.4, Math.min(this.S.w, this.S.h) / (m * 2 + 76));
      this.S.cam.k += (k - this.S.cam.k) * 0.08;
      this.S.cam.x += (0 - this.S.cam.x) * 0.08;
      this.S.cam.y += (0 - this.S.cam.y) * 0.08;
    }

    /* --------------------------------------------------------------- draw */
    /**
     * Applications resolve to a vendor mark by id; routines and skills have no vendor, so
     * they resolve by group — every agent looks like an agent, every hook like a hook.
     */
    iconFor(n) {
      if (n.isHub || n.isCenter) return null;
      if (this.iconCache.has(n.id)) return this.iconCache.get(n.id);
      let key = null;
      if (n.layer === "applications") {
        const hay = (n.id + " " + n.label).toLowerCase();
        key = "plug";
        for (const [needle, k] of ALIASES) if (hay.indexOf(needle) >= 0) { key = k; break; }
      } else if (n.layer === "routines") {
        key = GROUP_GLYPH[n.group] || "command";
      } else if (n.layer === "skills") {
        key = GROUP_GLYPH[n.group] || "skill";
      }
      this.iconCache.set(n.id, key);
      return key;
    }

    matches(n) {
      const q = this.S.query.toLowerCase();
      if (!q) return true;
      if (n.isHub) return n.group.toLowerCase().indexOf(q) >= 0 || n.members.some((m) => this.matches(m));
      return (n.label || "").toLowerCase().indexOf(q) >= 0 ||
        (n.id || "").toLowerCase().indexOf(q) >= 0 ||
        (n.description || "").toLowerCase().indexOf(q) >= 0;
    }

    hexBg() {
      const S = this.S, ctx = this.ctx;
      if (!S.hex) return;
      const k = S.cam.k, R = 34 * k;
      if (R < 9) return;
      const dx = R * Math.sqrt(3), dy = R * 1.5;
      const ox = ((S.w / 2 + S.cam.x) % dx), oy = ((S.h / 2 + S.cam.y) % (dy * 2));
      ctx.save();
      ctx.strokeStyle = this.T.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let row = -1, y = oy - dy * 2; y < S.h + dy * 2; y += dy, row++) {
        const sh = row & 1 ? dx / 2 : 0;
        for (let x = ox - dx; x < S.w + dx; x += dx) {
          const cx = x + sh, cy = y;
          for (let i = 0; i < 6; i++) {
            const a1 = (Math.PI / 180) * (60 * i - 30), a2 = (Math.PI / 180) * (60 * (i + 1) - 30);
            if (i === 0) ctx.moveTo(cx + R * Math.cos(a1), cy + R * Math.sin(a1));
            ctx.lineTo(cx + R * Math.cos(a2), cy + R * Math.sin(a2));
          }
        }
      }
      ctx.stroke(); ctx.restore();
    }

    draw() {
      const S = this.S, ctx = this.ctx, T = this.T;
      ctx.clearRect(0, 0, S.w, S.h);
      this.hexBg();
      const k = S.cam.k;
      ctx.save();
      ctx.translate(S.w / 2 + S.cam.x, S.h / 2 + S.cam.y);
      ctx.scale(k, k);

      if (S.layout === "rings") {
        for (const key of this.ORDER) {
          if (S.offLayers.has(key)) continue;
          if (!this.VIS.some((n) => n.layer === key)) continue;
          ctx.beginPath(); ctx.arc(0, 0, this.BAND[key], 0, TAU);
          ctx.strokeStyle = this.LAYER[key].color + "44";
          ctx.lineWidth = 1.1 / k; ctx.stroke();
        }
      }

      const focus = S.hover || S.sel;
      const near = focus ? this.ADJ.get(focus.id) || new Set() : null;
      const isDim = (n) => focus && n.id !== focus.id && !(near && near.has(n.id));

      for (const n of this.VIS) {
        if (!n.isHub) continue;
        const L = this.LAYER[n.layer]; if (!L) continue;
        const rr = n.r * 3;
        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, rr);
        g.addColorStop(0, L.color + "1c"); g.addColorStop(1, L.color + "00");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, n.y, rr, 0, TAU); ctx.fill();
      }
      if (this.CENTER && this.CENTER.__vis) {
        const C = this.CENTER, rr = C.r * 4.4;
        const g = ctx.createRadialGradient(C.x, C.y, 0, C.x, C.y, rr);
        g.addColorStop(0, "rgba(" + T.coreGlow + ",.30)");
        g.addColorStop(0.5, "rgba(" + T.coreGlow + ",.07)");
        g.addColorStop(1, "rgba(" + T.coreGlow + ",0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(C.x, C.y, rr, 0, TAU); ctx.fill();

        ctx.save();
        ctx.strokeStyle = T.spoke;
        for (const n of this.VIS) {
          if (!n.isHub && !(n.layer === "applications" || n.layer === "routines")) continue;
          ctx.lineWidth = (n.isHub ? 1 : 0.5) / k;
          ctx.beginPath(); ctx.moveTo(C.x, C.y); ctx.lineTo(n.x, n.y); ctx.stroke();
        }
        ctx.restore();
      }

      if (S.edges) {
        for (const e of this.EDGES) {
          const s = e.s.__proxy || e.s, t = e.t.__proxy || e.t;
          if (!s.__vis || !t.__vis || s === t) continue;
          const hot = focus && (s.id === focus.id || t.id === focus.id);
          const dim = focus && !hot;
          const bulk = e.kind === "writes-to";
          ctx.strokeStyle = hot ? T.edgeHot : dim ? T.edgeDim : bulk ? T.edgeBulk : T.edge;
          ctx.lineWidth = (hot ? 1.6 : 0.75) / k;
          ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
        }
      }

      for (const n of this.VIS) {
        const L = this.LAYER[n.layer] || { color: "#8b97a4" };
        const m = this.matches(n);
        const dim = isDim(n) || (S.query && !m);
        ctx.globalAlpha = dim ? 0.16 : 1;

        if (focus && n.id === focus.id) {
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 8 / k, 0, TAU);
          ctx.fillStyle = L.color + "22"; ctx.fill();
        }
        if (S.query && m && !dim) {
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 6 / k, 0, TAU);
          ctx.strokeStyle = T.match; ctx.lineWidth = 1.5 / k; ctx.stroke();
        }

        if (n.isHub || n.isCenter) {
          ctx.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 180) * (60 * i - 30);
            const px = n.x + n.r * Math.cos(a), py = n.y + n.r * Math.sin(a);
            i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          }
          ctx.closePath();
          ctx.fillStyle = n.isCenter ? T.core : L.color + "2a";
          ctx.fill();
          ctx.strokeStyle = n.isCenter ? T.core : L.color;
          ctx.lineWidth = (n.isCenter ? 2.4 : 1.7) / k; ctx.stroke();
        } else {
          const st = n.status, glyph = this.iconFor(n);
          const fav = n.layer === "applications" && n.r * k > 5 ? favicon(glyph) : null;
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, TAU);
          if (fav) {
            ctx.fillStyle = T.chip;
            ctx.fill();
            if (st !== "needs-auth" && st !== "unknown") {
              ctx.strokeStyle = T.chipRing; ctx.lineWidth = 1 / k; ctx.stroke();
            }
          } else {
            ctx.fillStyle = st === "disabled" ? L.color + "12"
              : st === "needs-auth" ? L.color + "33" : L.color;
            ctx.fill();
          }
          if (st === "retracted") { ctx.strokeStyle = "#e0ad48"; ctx.lineWidth = 1.4 / k; ctx.stroke(); }
          if (st === "needs-auth") {
            ctx.setLineDash([2.4 / k, 2 / k]);
            ctx.strokeStyle = L.color; ctx.lineWidth = 1.5 / k; ctx.stroke();
            ctx.setLineDash([]);
          } else if (st === "disabled") {
            ctx.strokeStyle = "rgba(232,105,95,.45)"; ctx.lineWidth = 1.4 / k; ctx.stroke();
          } else if (st === "unknown") {
            ctx.strokeStyle = "#e0ad48"; ctx.lineWidth = 1.4 / k; ctx.stroke();
          }
          if (fav) {
            const box = n.r * 1.3;
            if (st === "needs-auth") ctx.globalAlpha *= 0.6;
            if (st === "disabled") { ctx.filter = "grayscale(1)"; ctx.globalAlpha *= 0.5; }
            ctx.drawImage(fav, n.x - box / 2, n.y - box / 2, box, box);
            ctx.filter = "none";
            ctx.globalAlpha = dim ? 0.16 : 1;
          }
          if (st === "disabled") {
            const d = n.r * 0.55;
            ctx.beginPath();
            ctx.moveTo(n.x - d, n.y - d); ctx.lineTo(n.x + d, n.y + d);
            ctx.moveTo(n.x + d, n.y - d); ctx.lineTo(n.x - d, n.y + d);
            ctx.strokeStyle = "#e8695f"; ctx.lineWidth = 1.3 / k; ctx.stroke();
          }
          if (!fav && glyph && n.r * k > 5 && st !== "disabled") {
            const box = n.r * 1.16;
            const px = Math.max(16, Math.min(192, Math.ceil((box * k * this.S.dpr) / 8) * 8));
            const tint = st === "needs-auth" ? L.color : T.knock;
            ctx.drawImage(sprite(glyph, px, tint), n.x - box / 2, n.y - box / 2, box, box);
          }
        }
        ctx.globalAlpha = 1;
      }

      if (S.labels) {
        const claimed = [], gapX = 8 / k, gapY = 13 / k;
        const fits = (x, y, w) => !claimed.some((b) => Math.abs(x - b.x) < (w + b.w) * 0.5 + gapX && Math.abs(y - b.y) < gapY);
        const order = this.VIS.slice().sort((a, b) => {
          const p = (n) => (focus && n.id === focus.id ? 1e7 : 0) + (S.query && this.matches(n) ? 1e6 : 0) +
            (n.isCenter ? 1e5 : 0) + (n.isHub ? 1e4 : 0) + n.r * 10;
          return p(b) - p(a);
        });
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        for (const n of order) {
          const m = this.matches(n);
          const dim = isDim(n) || (S.query && !m);
          const must = (focus && n.id === focus.id) || (S.query && m) || n.isCenter;
          if (dim && !must) continue;
          if (!must && n.r * k < 6.5) continue;
          const big = n.isHub || n.isCenter;
          const fs = (big ? 12 : 10.5) / k;
          ctx.font = (big ? 600 : 400) + " " + fs + "px " + (big ? this.SANS : this.MONO);
          let lab = n.label || "";
          if (n.isHub) lab = n.group + " \u00b7 " + n.members.length;
          const w = ctx.measureText(lab).width;
          const ly = n.y + n.r + 5 / k;
          if (!must && !fits(n.x, ly, w)) continue;
          claimed.push({ x: n.x, y: ly, w });
          ctx.globalAlpha = must ? 1 : big ? 0.95 : 0.82;
          ctx.fillStyle = big ? T.label : T.labelDim;
          ctx.fillText(lab, n.x, ly);
        }
        ctx.globalAlpha = 1;
      }

      if (S.layout === "rings") {
        ctx.save();
        ctx.textBaseline = "middle";
        for (const key of this.ORDER) {
          if (S.offLayers.has(key)) continue;
          if (!this.VIS.some((n) => n.layer === key)) continue;
          const L = this.LAYER[key], R = this.BAND[key];
          /* Leader-line callout riding its ring: the anchor rotates with the layer's spin,
             so the label travels with the nodes instead of floating over them. */
          const va = -TAU / 4 + this.S.t * (this.S.spin * 0.00022) * (key === "applications" ? 0.6 : 1);
          const ax = Math.cos(va) * R, ay = Math.sin(va) * R;
          const dir = ax >= 0 ? 1 : -1;
          const ex = ax + (dir * 26) / k, ey = ay - 26 / k, hx = ex + (dir * 44) / k;
          ctx.globalAlpha = 0.85;
          ctx.strokeStyle = L.color;
          ctx.lineWidth = 1 / k;
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ex, ey); ctx.lineTo(hx, ey); ctx.stroke();
          ctx.beginPath(); ctx.arc(ax, ay, 2.4 / k, 0, TAU); ctx.fillStyle = L.color; ctx.fill();
          ctx.beginPath(); ctx.arc(hx + (dir * 5.2) / k, ey, 4.6 / k, 0, TAU); ctx.stroke();
          ctx.font = "400 " + 10.5 / k + "px " + this.MONO;
          if ("letterSpacing" in ctx) ctx.letterSpacing = 3.2 / k + "px";
          ctx.textAlign = dir === 1 ? "left" : "right";
          ctx.lineJoin = "round";
          ctx.strokeStyle = T.halo;
          ctx.lineWidth = 4 / k;
          const tx = hx + (dir * 16) / k;
          ctx.globalAlpha = 1;
          ctx.strokeText(L.label, tx, ey);
          ctx.fillStyle = L.color;
          ctx.fillText(L.label, tx, ey);
          if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
        }
        ctx.restore();
      }
      ctx.restore();
    }

    frame() {
      for (const n of this.N) { n.__vis = false; n.__proxy = null; }
      for (const h of this.HUBS.values()) h.__vis = false;
      for (const n of this.VIS) n.__vis = true;
      for (const [k, g] of this.GROUPS) {
        if (this.S.expanded.has(k)) continue;
        const h = this.HUBS.get(k);
        for (const m of g.members) m.__proxy = h;
      }
      this.step(16);
      if (this.S.autofit) this.fit();
      this.draw();
      this._raf = requestAnimationFrame(() => this.frame());
    }

    /* -------------------------------------------------------- interaction */
    toWorld(px, py) {
      return { x: (px - this.S.w / 2 - this.S.cam.x) / this.S.cam.k, y: (py - this.S.h / 2 - this.S.cam.y) / this.S.cam.k };
    }
    pick(px, py) {
      const p = this.toWorld(px, py);
      let best = null, bd = Infinity;
      for (const n of this.VIS) {
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < n.r + 8 / this.S.cam.k && d < bd) { bd = d; best = n; }
      }
      return best;
    }

    openDetail(n) {
      this.S.sel = n;
      const L = this.LAYER[n.layer] || { label: n.layer, color: "#8b97a4" };
      const rel = [...(this.ADJ.get(n.id) || new Set())]
        .map((id) => this.BY.get(id)).filter(Boolean)
        .map((m) => ({ id: m.id, label: m.label, layer: (this.LAYER[m.layer] || {}).label || m.layer }));
      this.onSelect({
        id: n.id, label: n.label, layerLabel: L.label, layerColor: L.color, group: n.group,
        description: n.description || "\u2014",
        kv: [["detail", n.detail || "\u2014"], ["status", n.status || "\u2014"]]
          .concat(n.machine && n.machine !== "both" ? [["machine", n.machine]] : [])
          .concat([["links", String((this.ADJ.get(n.id) || new Set()).size)]]),
        related: rel
      });
    }

    _bind() {
      const cv = this.cv;
      let drag = null, pan = null, moved = false, downAt = null;
      const self = this;
      const off = [];
      const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); off.push(() => el.removeEventListener(ev, fn, opt)); };

      on(cv, "pointerdown", (ev) => {
        if (ev.button !== 0 || drag || pan) return;
        cv.setPointerCapture(ev.pointerId); moved = false;
        downAt = { x: ev.offsetX, y: ev.offsetY };
        const hit = self.pick(ev.offsetX, ev.offsetY);
        if (hit) { drag = hit; hit.held = true; }
        else pan = { x: ev.offsetX, y: ev.offsetY, cx: self.S.cam.x, cy: self.S.cam.y };
        cv.style.cursor = "grabbing";
      });
      on(cv, "pointerleave", () => { self.S.hover = null; });
      on(cv, "pointercancel", () => {
        if (drag) drag.held = false;
        drag = null; pan = null; cv.style.cursor = "grab";
      });
      on(cv, "pointermove", (ev) => {
        if (drag) {
          const p = self.toWorld(ev.offsetX, ev.offsetY);
          drag.x = p.x; drag.y = p.y; drag.vx = 0; drag.vy = 0;
          if (downAt && Math.hypot(ev.offsetX - downAt.x, ev.offsetY - downAt.y) > 3) { moved = true; self.S.autofit = false; }
        } else if (pan) {
          self.S.cam.x = pan.cx + (ev.offsetX - pan.x);
          self.S.cam.y = pan.cy + (ev.offsetY - pan.y);
          if (Math.hypot(ev.offsetX - pan.x, ev.offsetY - pan.y) > 3) { moved = true; self.S.autofit = false; }
        } else {
          const h = self.pick(ev.offsetX, ev.offsetY);
          if (h !== self.S.hover) { self.S.hover = h; cv.style.cursor = h ? "pointer" : "grab"; }
        }
      });
      on(cv, "pointerup", () => {
        cv.style.cursor = "grab";
        if (drag) {
          drag.held = false;
          if (!moved) {
            if (drag.isHub) { self.S.expanded.add(drag.hubKey); self.rebuild(); self.emit(); }
            else self.openDetail(drag);
          }
          drag = null;
        } else if (pan && !moved) self.clearSelection();
        pan = null;
      });
      on(cv, "wheel", (ev) => {
        ev.preventDefault();
        self.S.autofit = false;
        const S = self.S;
        const f = Math.exp(-ev.deltaY * 0.0015);
        const k2 = Math.min(4, Math.max(0.15, S.cam.k * f));
        const mx = ev.offsetX - S.w / 2, my = ev.offsetY - S.h / 2;
        S.cam.x = mx - (mx - S.cam.x) * (k2 / S.cam.k);
        S.cam.y = my - (my - S.cam.y) * (k2 / S.cam.k);
        S.cam.k = k2;
      }, { passive: false });

      this._off = off;
      if (window.ResizeObserver) {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(cv);
      }
      cv.style.cursor = "grab";
    }
  }

  /* ------------------------------------------------------------ demo data */

export { CortexMap };
