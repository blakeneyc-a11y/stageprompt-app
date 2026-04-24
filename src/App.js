import React, { useState, useEffect, useRef, useCallback } from "react"

// ─── API ──────────────────────────────────────────────────────────────────────
const API   = "https://api.anthropic.com/v1/messages"
const MODEL = "claude-3-5-sonnet-20241022"
const pause = ms => new Promise(r => setTimeout(r, ms))

// API key — stored at module level and updated from UI
let _key = ""

async function askClaude(messages, system = "", maxTokens = 2000) {
  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true"
  }
  // Only add key header if we have one
  if (_key) headers["x-api-key"] = _key

  const res = await fetch(API, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages })
  })

  // Show HTTP status in error if not OK
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`
    try {
      const errBody = await res.json()
      errMsg = `HTTP ${res.status}: ${errBody?.error?.message || JSON.stringify(errBody?.error) || res.statusText}`
    } catch {}
    throw new Error(errMsg)
  }

  const d = await res.json()
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error))
  return d.content?.[0]?.text ?? ""
}

// ─── FILE HELPERS ─────────────────────────────────────────────────────────────
async function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload  = () => res(r.result.split(",")[1])
    r.onerror = rej
    r.readAsDataURL(file)
  })
}

async function correctOrientation(file) {
  if (!file.type.startsWith("image/")) return file
  const orient = await new Promise(resolve => {
    const fr = new FileReader()
    fr.onload = e => {
      try {
        const v = new DataView(e.target.result)
        if (v.getUint16(0) !== 0xFFD8) { resolve(1); return }
        let o = 2
        while (o < v.byteLength) {
          const mk = v.getUint16(o); o += 2
          if (mk === 0xFFE1) {
            if (v.getUint32(o+2) !== 0x45786966) { resolve(1); return }
            const le = v.getUint16(o+8) === 0x4949
            const ifd = o+8+v.getUint32(o+12,le)
            const n = v.getUint16(ifd,le)
            for (let i=0;i<n;i++) if (v.getUint16(ifd+2+i*12,le)===0x0112) { resolve(v.getUint16(ifd+2+i*12+8,le)); return }
            resolve(1); return
          }
          if ((mk & 0xFF00) !== 0xFF00) break
          o += v.getUint16(o)
        }
      } catch {}
      resolve(1)
    }
    fr.onerror = () => resolve(1)
    fr.readAsArrayBuffer(file.slice(0,65536))
  })
  if (orient <= 1) return file
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const [w,h] = [img.naturalWidth, img.naturalHeight]
      const c = document.createElement("canvas")
      const ctx = c.getContext("2d")
      if (orient>=5){c.width=h;c.height=w}else{c.width=w;c.height=h}
      ctx.save()
      const T={2:[-1,0,0,1,w,0],3:[-1,0,0,-1,w,h],4:[1,0,0,-1,0,h],5:[0,1,1,0,0,0],6:[0,1,-1,0,h,0],7:[0,-1,-1,0,h,w],8:[0,-1,1,0,0,w]}[orient]
      if (T) ctx.transform(...T)
      ctx.drawImage(img,0,0); ctx.restore()
      URL.revokeObjectURL(url)
      c.toBlob(b=>resolve(new File([b],file.name,{type:"image/jpeg"})),"image/jpeg",0.92)
    }
    img.onerror=()=>{URL.revokeObjectURL(url);resolve(file)}
    img.src=url
  })
}

function safeJSON(raw) {
  let s = raw.replace(/```[a-z]*\n?/gi,"").replace(/```/g,"").trim()
  const fb = s.indexOf("{"); if (fb>0) s=s.slice(fb)
  try { return JSON.parse(s) } catch {}
  try {
    let t=s
    let diff=(t.match(/[\[{]/g)||[]).length-(t.match(/[\]}]/g)||[]).length
    while(diff>0){const la=t.lastIndexOf("["),lo=t.lastIndexOf("{");t+=(la>lo?"]":"}");diff--}
    return JSON.parse(t)
  } catch {}
  return null
}

// ─── SCORING ──────────────────────────────────────────────────────────────────
function calcAccuracy(expected, spoken) {
  const norm = s=>s.toLowerCase().replace(/[^a-z0-9\s]/g,"").trim().split(/\s+/).filter(Boolean)
  const exp=norm(expected), spk=norm(spoken)
  if (!exp.length) return 100
  let hits=0; const used=new Set()
  for (const w of spk){const i=exp.findIndex((e,j)=>e===w&&!used.has(j));if(i>=0){hits++;used.add(i)}}
  return Math.round((hits/exp.length)*100)
}

function diffTokens(expected, spoken) {
  const norm=s=>s.toLowerCase().replace(/[^a-z0-9]/g,"")
  const spk=spoken.split(/\s+/).map(norm); const used=new Set()
  return expected.split(/(\s+)/).map(tok=>{
    if(/^\s+$/.test(tok)) return{sp:true,text:tok}
    const j=spk.findIndex((w,k)=>w===norm(tok)&&!used.has(k))
    if(j>=0){used.add(j);return{ok:true,text:tok}}
    return{ok:false,text:tok}
  })
}

const MEDALS={
  gold:  {emoji:"🥇",label:"Gold — Word Perfect!",  color:"#D97706"},
  silver:{emoji:"🥈",label:"Silver — Excellent!",   color:"#6B7280"},
  bronze:{emoji:"🥉",label:"Bronze — Good work!",   color:"#92400E"},
  none:  {emoji:"🎭",label:"Keep rehearsing!",       color:"#6B7280"}
}
function scoreMedal(results){
  if(!results.length) return{medal:"gold",accuracy:100,prompts:0}
  const avg=Math.round(results.reduce((s,r)=>s+r.accuracy,0)/results.length)
  const prompts=results.filter(r=>r.prompted).length
  if(avg===100&&prompts===0)return{medal:"gold",accuracy:avg,prompts}
  if(avg>=90&&prompts<=2)return{medal:"silver",accuracy:avg,prompts}
  if(avg>=75)return{medal:"bronze",accuracy:avg,prompts}
  return{medal:"none",accuracy:avg,prompts}
}

// ─── DROP ZONE ────────────────────────────────────────────────────────────────
function DropZone({onProcess}){
  const [files,setFiles]=useState([])
  const [drag,setDrag]=useState(false)
  const ref=useRef(null)
  const accept=fs=>Array.from(fs).filter(f=>f.type.startsWith("image/")||f.type==="application/pdf")
  return(
    <div className="dz-wrap">
      <div className={`dz${drag?" drag":""}${files.length?" filled":""}`}
        onDragOver={e=>{e.preventDefault();setDrag(true)}}
        onDragLeave={()=>setDrag(false)}
        onDrop={e=>{e.preventDefault();setDrag(false);setFiles(accept(e.dataTransfer.files))}}
        onClick={()=>ref.current?.click()}>
        <input ref={ref} type="file" multiple accept="image/*,.pdf" hidden
          onChange={e=>setFiles(accept(e.target.files))}/>
        {!files.length?<>
          <div className="dz-ico">📄</div>
          <p className="dz-txt">Drop your script pages here</p>
          <p className="dz-sub">PDF · JPG · PNG · HEIC — multiple pages OK</p>
        </>:<>
          <div className="dz-ico">✅</div>
          <p className="dz-txt">{files.length} file{files.length>1?"s":""} ready</p>
          <ul className="dz-list">{files.slice(0,5).map((f,i)=><li key={i}>{f.name}</li>)}{files.length>5&&<li>…and {files.length-5} more</li>}</ul>
        </>}
      </div>
      {files.length>0&&<button className="go-btn" onClick={()=>onProcess(files)}>📖 Read My Script</button>}
    </div>
  )
}

// ─── ELAPSED TIMER ────────────────────────────────────────────────────────────
function ElapsedTimer({running}){
  const [secs,setSecs]=useState(0)
  const startRef=useRef(Date.now())
  useEffect(()=>{
    if(!running){setSecs(0);startRef.current=Date.now();return}
    startRef.current=Date.now()
    const iv=setInterval(()=>setSecs(Math.floor((Date.now()-startRef.current)/1000)),1000)
    return()=>clearInterval(iv)
  },[running])
  if(!running||secs<3)return null
  const m=Math.floor(secs/60), s=secs%60
  return<span className="elapsed">{m>0?`${m}m `:""}{s}s elapsed — still working…</span>
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function StagePrompt(){
  const [screen,   setScreen]   = useState("upload")
  const [apiKey,   setApiKey]   = useState("")
  const [keyReady, setKeyReady] = useState(false)
  const [procStep, setProcStep] = useState("")
  const [procProg, setProcProg] = useState(0)
  const [procErr,  setProcErr]  = useState("")
  const [script,   setScript]   = useState(null)
  const [voices,   setVoices]   = useState([])

  // Multiple roles: myRoles is a Set of character names the user plays
  const [myRoles,    setMyRoles]    = useState(new Set())
  const [selScene,   setSelScene]   = useState("")
  const [recordings, setRecordings] = useState({})
  const [recFor,     setRecFor]     = useState(null)
  const [isRec,      setIsRec]      = useState(false)
  const [skipNoChar, setSkipNoChar] = useState(false)
  const mediaRef=useRef(null); const chunksRef=useRef([])

  // Review
  const [reviewMode,   setReviewMode]   = useState("scroll")
  const [reviewFilter, setReviewFilter] = useState("flagged")
  const [stepIdx,      setStepIdx]      = useState(0)
  const [editLine,     setEditLine]     = useState(null)
  const [editText,     setEditText]     = useState("")
  const [editChar,     setEditChar]     = useState("")
  const [isVoiceCorr,  setIsVoiceCorr]  = useState(false)
  const dragRef = useRef(null) // {si, li} of the line being dragged

  // Rehearsal
  const [hideStageDir, setHideStageDir] = useState(false)
  const [phase,       setPhase]       = useState("idle")
  const [curIdx,      setCurIdx]      = useState(0)
  const [lineResults, setLineResults] = useState([])
  const [curSpoken,   setCurSpoken]   = useState("")
  const [curAccuracy, setCurAccuracy] = useState(null)
  const [promptHint,  setPromptHint]  = useState("")
  const rehearsalOn=useRef(false); const promptedRef=useRef(false)
  const sceneRef=useRef({lines:[],myChars:[]})

  const [history,setHistory]=useState([])
  const [wModal, setWModal] =useState(null)
  const [wResult,setWResult]=useState("")
  const [wLoad,  setWLoad]  =useState(false)

  const myChars = [...myRoles]

  // ── Voices ────────────────────────────────────────────────────────────────
  useEffect(()=>{
    const load=()=>{const v=window.speechSynthesis?.getVoices()||[];if(v.length)setVoices(v)}
    load(); if(window.speechSynthesis)window.speechSynthesis.onvoiceschanged=load
    return()=>{if(window.speechSynthesis)window.speechSynthesis.onvoiceschanged=null}
  },[])

  const pickVoice=useCallback((type,idx)=>{
    if(!voices.length)return null
    const fem=["samantha","victoria","karen","moira","fiona","tessa","allison","ava","zira","hazel"]
    const mal=["daniel","alex","fred","george","james","david","mark","thomas","lee","gordon"]
    const pool=voices.filter(v=>{const n=v.name.toLowerCase();if(type==="female")return n.includes("female")||fem.some(x=>n.includes(x));if(type==="male")return n.includes("male")||mal.some(x=>n.includes(x));return true})
    const list=pool.length?pool:voices
    return list[idx%list.length]||voices[0]||null
  },[voices])

  const toggleMyRole=name=>setMyRoles(prev=>{const n=new Set(prev);n.has(name)?n.delete(name):n.add(name);return n})

  // ── STT ───────────────────────────────────────────────────────────────────
  const listenOnce=()=>new Promise(resolve=>{
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition
    if(!SR){resolve("");return}
    const rec=new SR(); rec.continuous=false; rec.interimResults=true; rec.lang="en-GB"
    let final=""; let done=false
    const finish=v=>{if(!done){done=true;resolve(v)}}
    rec.onresult=e=>{
      let interim=""
      for(let i=e.resultIndex;i<e.results.length;i++){if(e.results[i].isFinal)final+=e.results[i][0].transcript+" ";else interim+=e.results[i][0].transcript}
      setCurSpoken(final+interim)
      if(e.results[e.results.length-1].isFinal)finish(final.trim())
    }
    rec.onerror=()=>finish(final.trim()); rec.onend=()=>finish(final.trim())
    try{rec.start()}catch{finish("")}
  })

  // ── PROCESS FILES ─────────────────────────────────────────────────────────
  const processFiles=async(files)=>{
    setScreen("processing"); setProcProg(5); setProcErr("")

    const images=[], pdfs=[]
    for(const f of files){if(f.type==="application/pdf")pdfs.push(f);else images.push(f)}

    // Step 1: orientation
    setProcStep("Checking page orientation…")
    const corrected=[]
    for(let i=0;i<images.length;i++){
      setProcProg(5+Math.round((i/Math.max(images.length,1))*10))
      corrected.push(await correctOrientation(images[i]))
    }
    setProcProg(15)

    // Step 2: OCR — batch images 8 at a time
    const rawTexts=[]
    const BATCH=8
    for(let b=0;b<corrected.length;b+=BATCH){
      const batch=corrected.slice(b,b+BATCH)
      const ps=b+1,pe=Math.min(b+BATCH,corrected.length)
      setProcStep(corrected.length===1?"Reading script page…":`Reading pages ${ps}–${pe} of ${corrected.length}…`)
      setProcProg(15+Math.round((b/Math.max(corrected.length,1))*28))
      const content=[]
      for(let i=0;i<batch.length;i++){
        content.push({type:"image",source:{type:"base64",media_type:"image/jpeg",data:await toBase64(batch[i])}})
        content.push({type:"text",text:`[Page ${ps+i}]`})
      }
      content.push({type:"text",text:`Extract ALL text from these ${batch.length} theatre play script page(s). Label each === PAGE N ===. Preserve: character names (CAPS on own line), stage directions (in brackets/parens), act/scene headings, every word of every line. Do not skip or summarise anything. Pages may be slightly rotated — read them regardless.`})
      try{rawTexts.push(await askClaude([{role:"user",content}],"Specialist script OCR. Extract every word faithfully.",Math.min(3000*batch.length,16000)))}
      catch(e){rawTexts.push(`[Pages ${ps}-${pe} error: ${e.message}]`)}
    }
    for(let i=0;i<pdfs.length;i++){
      setProcStep(`Reading PDF${pdfs.length>1?` ${i+1}/${pdfs.length}`:""}…`)
      setProcProg(44+Math.round((i/Math.max(pdfs.length,1))*12))
      try{rawTexts.push(await askClaude([{role:"user",content:[
        {type:"document",source:{type:"base64",media_type:"application/pdf",data:await toBase64(pdfs[i])}},
        {type:"text",text:"Extract ALL text from this theatre play script PDF. Preserve character names (CAPS before their lines), stage directions, act/scene headings, all dialogue verbatim. Do not skip or summarise anything."}
      ]}],"Specialist script OCR.",16000))}
      catch(e){rawTexts.push(`[PDF error: ${e.message}]`)}
    }

    const fullText=rawTexts.join("\n\n").trim()
    if(!fullText){
      setProcErr("No text could be extracted. Please try a clearer image or a digital PDF."); return
    }

    // Step 3: Multi-pass character & heading extraction (handles very long scripts)
    setProcStep("Identifying all characters and scenes across the whole script…"); setProcProg(58)
    let meta={title:"Untitled Play",characters:[],sceneHeadings:[]}
    try{
      const mRawA=await askClaude([{role:"user",content:
        `Read this play script and find: (1) the play title, (2) EVERY character who speaks, (3) ALL section headings (Prologue, Scene 1 … Scene N, Epilogue etc.)
Return ONLY valid JSON, no markdown:
{"title":"Play Title","characters":["NAME1","NAME2"],"sceneHeadings":["Prologue","Scene 1"]}
Read the WHOLE text. Do not stop early.
SCRIPT (part 1):\n${fullText.slice(0,40000)}`
      }],"Theatre analyst. Return only valid compact JSON.",3000)
      const mA=safeJSON(mRawA); if(mA&&Array.isArray(mA.characters))meta=mA
      if(fullText.length>40000){
        setProcStep("Scanning remainder of script for additional characters…"); setProcProg(61)
        const mRawB=await askClaude([{role:"user",content:
          `From this second portion of the same play, find any ADDITIONAL speaking characters not in [${meta.characters.join(", ")}] and any additional scene headings.
Return ONLY JSON: {"additionalCharacters":["NAME3"],"additionalHeadings":["Scene 7"]}
SCRIPT (part 2):\n${fullText.slice(40000,90000)}`
        }],"Theatre analyst. Return only valid compact JSON.",2000)
        const mB=safeJSON(mRawB)
        if(mB){
          if(Array.isArray(mB.additionalCharacters))meta.characters=[...new Set([...meta.characters,...mB.additionalCharacters])]
          if(Array.isArray(mB.additionalHeadings))meta.sceneHeadings=[...new Set([...meta.sceneHeadings,...mB.additionalHeadings])]
        }
      }
      if(fullText.length>90000){
        const mRawC=await askClaude([{role:"user",content:
          `Third portion — find any additional characters not in [${meta.characters.join(", ")}] and additional scene headings not in [${meta.sceneHeadings.join(", ")}].
Return ONLY JSON: {"additionalCharacters":[],"additionalHeadings":[]}
SCRIPT (part 3):\n${fullText.slice(90000,140000)}`
        }],"Theatre analyst. Return only valid compact JSON.",1500)
        const mC=safeJSON(mRawC)
        if(mC){
          if(Array.isArray(mC.additionalCharacters))meta.characters=[...new Set([...meta.characters,...mC.additionalCharacters])]
          if(Array.isArray(mC.additionalHeadings))meta.sceneHeadings=[...new Set([...meta.sceneHeadings,...mC.additionalHeadings])]
        }
      }
    }catch{}

    // Step 4: Scene-aware chunking with overlap — each scene becomes its own chunk;
    //         very long scenes get sub-chunked. Long plays (150pp) handled automatically.
    setProcStep("Splitting script into sections…"); setProcProg(64)
    const SCENE_RE=/(?:^|\n)((?:PROLOGUE|EPILOGUE|(?:ACT\s*\d+[\s,]*)?SCENE\s*\d+|Scene\s+\d+|Prologue|Epilogue)[^\n]*)/gi
    const hmatches=[...fullText.matchAll(SCENE_RE)]
    const MAX_CHUNK=5000, OVERLAP=500
    let textChunks=[]

    if(hmatches.length>=2){
      // Pre-heading text (prologue / cast list)
      if(hmatches[0].index>100)
        textChunks.unshift({label:"Opening",text:fullText.slice(0,Math.min(hmatches[0].index+300,MAX_CHUNK)),startScene:meta.sceneHeadings[0]||"Prologue"})
      for(let i=0;i<hmatches.length;i++){
        const label=hmatches[i][1].trim()
        const start=hmatches[i].index
        const end=i+1<hmatches.length?hmatches[i+1].index:fullText.length
        const sec=fullText.slice(Math.max(0,start-300),end)
        if(sec.length>MAX_CHUNK){
          // Sub-chunk long scenes
          let pos=0,sub=0
          while(pos<sec.length){
            const cut=sec.length>pos+MAX_CHUNK?Math.max(sec.lastIndexOf("\n",pos+MAX_CHUNK),pos+MAX_CHUNK*0.6):sec.length
            textChunks.push({label:`${label}${sub>0?` (part ${sub+1})`:""}`,text:sec.slice(pos,cut),startScene:label})
            pos=Math.max(pos+1,cut-OVERLAP); sub++
          }
        } else {
          textChunks.push({label,text:sec,startScene:label})
        }
      }
    } else {
      let pos=0,ci=0
      const hlist=meta.sceneHeadings.length>0?meta.sceneHeadings:["Scene 1"]
      while(pos<fullText.length){
        const cut=fullText.length>pos+MAX_CHUNK?Math.max(fullText.lastIndexOf("\n",pos+MAX_CHUNK),pos+MAX_CHUNK*0.6):fullText.length
        textChunks.push({label:`Part ${ci+1}`,text:fullText.slice(pos,cut),startScene:hlist[Math.min(ci,hlist.length-1)]})
        pos=Math.max(pos+1,cut-OVERLAP); ci++
      }
    }

    const totalChunks=textChunks.length
    const knownChars=meta.characters.join(", ")||"look for names in ALL CAPITALS"
    const knownScenes=meta.sceneHeadings.join(", ")||"Prologue, Scene 1 ... Epilogue"
    const allParsedLines=[]

    for(let ci=0;ci<totalChunks;ci++){
      const chunk=textChunks[ci]
      setProcProg(64+Math.round((ci/totalChunks)*29))
      setProcStep(`Parsing ${chunk.label} — ${ci+1} of ${totalChunks} sections…`)
      try{
        const pRaw=await askClaude([{role:"user",content:
          `Parse this theatre play script section into JSON lines.
Known characters: ${knownChars}
Known sections: ${knownScenes}
Current section: ${chunk.startScene}

Return ONLY this JSON (no markdown):
{"lines":[
  {"character":"NAME","text":"exact dialogue","isStageDirection":false,"scene":"${chunk.startScene}","flagged":false},
  {"character":null,"text":"(Stage direction)","isStageDirection":true,"scene":"${chunk.startScene}","flagged":false}
]}

RULES — failure to follow these means the actor cannot learn their lines:
- Include EVERY spoken line, even single words ("Yes." "No!" "Help!")
- Character name formats: NAME alone on a line, NAME., NAME: — all mean the same thing
- Update "scene" field when a new heading appears in the text
- flagged:true ONLY for genuinely illegible text
- Default scene if none visible: "${chunk.startScene}"
- DO NOT skip, omit or summarise any dialogue whatsoever

SCRIPT SECTION:\n${chunk.text}`
        }],"Expert theatre script parser. Include every single line. Never skip dialogue.",7000)
        const pd=safeJSON(pRaw)
        if(pd&&Array.isArray(pd.lines)&&pd.lines.length>0){
          allParsedLines.push(...pd.lines.map(l=>({...l,_ci:ci})))
        } else {
          // Store raw response snippet for diagnostics
          allParsedLines.push({character:null,text:`[${chunk.label} parse failed — raw: ${pRaw.slice(0,120)}]`,isStageDirection:true,scene:chunk.startScene,flagged:true,_ci:ci})
        }
      }catch(e){
        allParsedLines.push({character:null,text:`[API error on ${chunk.label}: ${e.message}]`,isStageDirection:true,scene:chunk.startScene,flagged:true,_ci:ci})
      }
    }

    // Dedup overlap lines
    setProcStep("Tidying up…"); setProcProg(94)
    const deduped=[]
    for(const line of allParsedLines){
      const{_ci,...rest}=line
      const key=`${rest.character}||${(rest.text||"").trim().slice(0,80)}`
      if(!deduped.slice(-10).some(l=>`${l.character}||${(l.text||"").trim().slice(0,80)}`===key)) deduped.push(rest)
    }

    // Group into scenes — be very forgiving about scene name matching
    const sceneMap=new Map(); const sceneOrder=[]
    for(const line of deduped){
      // Normalise scene name: trim, collapse whitespace
      const sc=((line.scene||"").trim().replace(/\s+/g," "))||"Scene 1"
      if(!sceneMap.has(sc)){sceneMap.set(sc,[]);sceneOrder.push(sc)}
      sceneMap.get(sc).push(line)
    }

    // If meta gave us scene headings, try to match them to what we got
    // Use fuzzy matching — "Scene 1" matches "SCENE 1", "Act 1 Scene 1" etc.
    const fuzzy=s=>s.toLowerCase().replace(/[^a-z0-9]/g,"")
    let orderedNames=sceneOrder
    if(meta.sceneHeadings?.length>0){
      const mapped=[]
      for(const mh of meta.sceneHeadings){
        // Try exact match first, then fuzzy
        const exact=sceneOrder.find(s=>s===mh.trim())
        const fuzz=exact||sceneOrder.find(s=>fuzzy(s)===fuzzy(mh))
        if(fuzz&&!mapped.includes(fuzz)) mapped.push(fuzz)
      }
      // Add any scenes that didn't match meta headings at the end
      const extras=sceneOrder.filter(s=>!mapped.includes(s))
      orderedNames=[...mapped,...extras]
    }

    // Build scenes — fall back to putting ALL lines in one scene if grouping failed
    let scenes=orderedNames.filter(t=>sceneMap.has(t)).map(title=>({title,lines:sceneMap.get(title)}))
    if(!scenes.length&&deduped.length>0){
      // Grouping failed entirely — dump everything into one scene
      scenes=[{title:"Scene 1",lines:deduped}]
    }
    if(!scenes.length){
      scenes=[{title:"Scene 1",lines:[{character:null,text:"No lines found. Please use Review to add lines manually.",isStageDirection:true,flagged:true}]}]
    }

    // Collect all character names — from both meta pass AND parsed lines
    const parsedChars=[...new Set(deduped.map(l=>l.character).filter(Boolean))].sort()
    const finalChars=[...new Set([...(meta.characters||[]),...parsedChars])].sort()

    // If we got lines but no chars (meta failed), extract chars from lines only
    const charList=finalChars.length>0?finalChars:parsedChars

    const parsedScript={
      title:meta.title||"Untitled Play",
      characters:charList.map((name,i)=>({name,voiceType:i%2===0?"female":"male",voiceIdx:i})),
      scenes
    }
    const allL=scenes.flatMap(s=>s.lines)
    const dialogueLines=allL.filter(l=>!l.isStageDirection&&l.character)
    const flagged=allL.filter(l=>l.flagged)
    const pct=allL.length?Math.round(flagged.length/allL.length*100):0

    // Only fail if we truly got zero dialogue lines
    if(dialogueLines.length===0){
      // Show first error message from parsed lines to help diagnose
      const firstErr=allL.find(l=>l.text?.startsWith("["))
      const diag=firstErr?` (${firstErr.text.slice(0,120)})`:" — all chunks returned empty."
      setProcErr(`No dialogue was detected.${diag} Please try again or upload a clearer file.`); return
    }

    setProcStep(pct>50?`⚠ ${pct}% of lines need review.`:flagged.length?`Done — ${allL.length} lines, ${flagged.length} flagged for review.`:`Script read! ${dialogueLines.length} lines · ${charList.length} characters · ${scenes.length} section${scenes.length!==1?"s":""}`)
    setScript(parsedScript); setProcProg(100)
    setTimeout(()=>setScreen("review"),800)
  }

  // ── Review helpers ────────────────────────────────────────────────────────
  const updateLine=useCallback((si,li,upd)=>setScript(s=>({...s,scenes:s.scenes.map((sc,i)=>i!==si?sc:{...sc,lines:sc.lines.map((l,j)=>j!==li?l:{...l,...upd})})})),[])
  const addLine=useCallback((si,afterLi)=>setScript(s=>({...s,scenes:s.scenes.map((sc,i)=>i!==si?sc:{...sc,lines:[...sc.lines.slice(0,afterLi+1),{character:sc.lines[afterLi]?.character||"",text:"",isStageDirection:false,flagged:false},...sc.lines.slice(afterLi+1)]})})),[])
  const delLine=useCallback((si,li)=>setScript(s=>({...s,scenes:s.scenes.map((sc,i)=>i!==si?sc:{...sc,lines:sc.lines.filter((_,j)=>j!==li)})})),[])
  const moveLine=useCallback((si,fromLi,toLi)=>setScript(s=>({...s,scenes:s.scenes.map((sc,i)=>{
    if(i!==si)return sc
    const lines=[...sc.lines]
    const [moved]=lines.splice(fromLi,1)
    lines.splice(toLi,0,moved)
    return{...sc,lines}
  })})),[])
  const voiceCorrect=useCallback(async(si,li)=>{setIsVoiceCorr(true);try{const t=await listenOnce();if(t)updateLine(si,li,{text:t,flagged:false})}finally{setIsVoiceCorr(false)}},[updateLine])

  // ── Recording ─────────────────────────────────────────────────────────────
  const startRec=async name=>{
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true})
      const mr=new MediaRecorder(stream); chunksRef.current=[]
      mr.ondataavailable=e=>chunksRef.current.push(e.data)
      mr.onstop=()=>{
        const blob=new Blob(chunksRef.current,{type:"audio/webm"})
        setRecordings(p=>({...p,[name]:URL.createObjectURL(blob)}))
        stream.getTracks().forEach(t=>t.stop()); setIsRec(false); setRecFor(null)
      }
      mediaRef.current=mr; mr.start(); setIsRec(true); setRecFor(name)
    }catch{alert("Microphone access denied.")}
  }
  const stopRec=()=>mediaRef.current?.stop()

  // ── TTS ───────────────────────────────────────────────────────────────────
  const speak=useCallback((text,charName)=>new Promise(resolve=>{
    if(!text?.trim()){resolve();return}
    if(recordings[charName]){const a=new Audio(recordings[charName]);a.onended=resolve;a.onerror=resolve;a.play().catch(resolve);return}
    window.speechSynthesis.cancel()
    const u=new SpeechSynthesisUtterance(text)
    const ch=script?.characters.find(c=>c.name===charName)
    if(ch){u.voice=pickVoice(ch.voiceType,ch.voiceIdx);u.pitch=ch.voiceType==="female"?1.12:0.86;u.rate=0.88}
    u.onend=resolve;u.onerror=resolve;window.speechSynthesis.speak(u)
  }),[recordings,script,pickVoice])

  // ── Rehearsal loop ────────────────────────────────────────────────────────
  const startRehearsal=useCallback(async()=>{
    const scene=script?.scenes.find(s=>s.title===selScene)
    if(!scene||myChars.length===0)return
    const lines=scene.lines, myC=[...myChars]
    sceneRef.current={lines,myChars:myC}
    rehearsalOn.current=true; promptedRef.current=false
    const acc=[]
    setLineResults([]); setCurIdx(0); setCurSpoken(""); setCurAccuracy(null); setPromptHint(""); setPhase("idle"); setScreen("rehearsal")
    await pause(1000)
    for(let i=0;i<lines.length;i++){
      if(!rehearsalOn.current)return
      const line=lines[i]
      setCurIdx(i); setCurSpoken(""); setCurAccuracy(null); setPromptHint(""); promptedRef.current=false
      if(line.isStageDirection){setPhase("stage");await pause(1200);continue}
      if(!myC.includes(line.character)){
        setPhase("speaking"); await speak(line.text,line.character); await pause(350)
      }else{
        setPhase("myLine"); await pause(1800)
        if(!rehearsalOn.current)return
        setPhase("listening")
        const spoken=await listenOnce()
        if(!rehearsalOn.current)return
        const accuracy=calcAccuracy(line.text,spoken)
        const result={lineIdx:i,expected:line.text,spoken,accuracy,prompted:promptedRef.current,character:line.character}
        acc.push(result); setLineResults([...acc]); setCurSpoken(spoken); setCurAccuracy(accuracy); setPhase("showing"); await pause(3400)
      }
    }
    if(!rehearsalOn.current)return
    setPhase("complete"); rehearsalOn.current=false
    if(acc.length){const{medal,accuracy,prompts}=scoreMedal(acc);setHistory(h=>[...h,{scene:selScene,medal,accuracy,prompts,ts:Date.now()}])}
  },[script,selScene,myChars,speak])

  const stopRehearsal=()=>{rehearsalOn.current=false;window.speechSynthesis?.cancel();setPhase("idle");setScreen("setup")}
  const requestPrompt=()=>{
    const line=sceneRef.current.lines[curIdx];if(!line)return
    const words=line.text.split(" ")
    setPromptHint(words.slice(0,Math.max(3,Math.ceil(words.length*0.25))).join(" ")+"…")
    promptedRef.current=true
  }

  // ── Word lookup ───────────────────────────────────────────────────────────
  const lookupWord=async(word,lineText,mode="def")=>{
    const clean=word.replace(/[^\w'''\-]/g,"");if(clean.length<2)return
    setWModal({word:clean,lineText,mode});setWResult("");setWLoad(true)
    try{
      if(mode==="def")setWResult(await askClaude([{role:"user",content:`Define "${clean}" for a theatre actor. If archaic give the modern meaning. 2–3 sentences.`}],"Theatre vocabulary guide.",400))
      else setWResult(await askClaude([{role:"user",content:`Translate into plain modern English:\n"${lineText}"\nFocus on "${clean}". Give a full modern version of the whole line.`}],"Translator of archaic text for actors.",500))
    }catch{setWResult("Could not retrieve — please try again.")}
    setWLoad(false)
  }

  // ── Computed ──────────────────────────────────────────────────────────────
  const currentScene=script?.scenes.find(s=>s.title===selScene)
  const allLines=(currentScene?.lines||[]).filter(l=>!hideStageDir||!l.isStageDirection)
  const curLine=allLines[curIdx]

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return(
    <div className="app">
      <style>{CSS}</style>

      {/* ══ UPLOAD ══════════════════════════════════════════════════════════ */}
      {screen==="upload"&&(
        <div className="screen center-screen">
          <div className="upload-box">
            <div className="brand">
              <span className="brand-icon">🎭</span>
              <h1 className="brand-name">StagePrompt</h1>
              <p className="brand-sub">Your AI line-learning companion</p>
            </div>

            {!keyReady ? (
              <div className="key-card">
                <h2 className="key-title">Enter your Anthropic API key</h2>
                <p className="key-body">StagePrompt uses Claude AI to read your script. You need a free API key — you only enter this once per session.</p>
                <ol className="key-steps">
                  <li>Go to <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">console.anthropic.com</a> and sign up free</li>
                  <li>Click <strong>API Keys</strong> → <strong>Create Key</strong></li>
                  <li>Copy the key (starts with <code>sk-ant-</code>) and paste below</li>
                </ol>
                <div className="key-row">
                  <input className="key-input" type="password" placeholder="sk-ant-…"
                    value={apiKey} onChange={e=>setApiKey(e.target.value)}
                    onKeyDown={e=>{
                      if(e.key==="Enter"&&apiKey.trim().length>10){
                        _key=apiKey.trim()
                        setKeyReady(true)
                      }
                    }}/>
                  <button className="go-btn" disabled={apiKey.trim().length<10}
                    onClick={()=>{
                      _key=apiKey.trim()
                      setKeyReady(true)
                    }}>
                    Continue →
                  </button>
                </div>
                <p className="key-note">🔒 Your key stays in your browser — never stored or shared.</p>
              </div>
            ) : (
              <>
                <DropZone onProcess={processFiles}/>
                <button className="change-key-btn" onClick={()=>setKeyReady(false)}>Change API key</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ══ PROCESSING ══════════════════════════════════════════════════════ */}
      {screen==="processing"&&(
        <div className="screen center-screen">
          <div className="proc-card">
            <div className="spinner">📜</div>
            <h2 className="proc-title">Reading your script…</h2>
            <p className="proc-step">{procStep}</p>
            <div className="prog-track">
              <div className="prog-fill" style={{width:`${procProg}%`}}/>
              {procProg>0&&procProg<100&&<div className="prog-pulse"/>}
            </div>
            <div className="prog-foot">
              <span className="prog-pct">{procProg}%</span>
              <ElapsedTimer running={!procErr&&procProg<100}/>
            </div>
            {procErr
              ?<div className="proc-err"><p>{procErr}</p><button className="go-btn sm" style={{marginTop:"1rem"}} onClick={()=>{setProcErr("");setScreen("upload")}}>← Try Again</button></div>
              :<div className="proc-notice">
                <p>⏳ <strong>Please be patient</strong> — reading and parsing a full play script can take <strong>several minutes</strong>, and longer plays may take <strong>10–15 minutes or more</strong>.</p>
                <p style={{marginTop:".5rem"}}>The progress bar will keep moving as it works through each section. <strong>Please don't close or navigate away from this page</strong> or you'll need to start over.</p>
              </div>
            }
          </div>
        </div>
      )}

      {/* ══ REVIEW ══════════════════════════════════════════════════════════ */}
      {screen==="review"&&script&&(()=>{
        const flat   =script.scenes.flatMap((sc,si)=>sc.lines.map((l,li)=>({...l,si,li,scTitle:sc.title})))
        const flagged=flat.filter(l=>l.flagged)
        const pct    =flat.length?Math.round(flagged.length/flat.length*100):0
        const stepSrc=reviewFilter==="flagged"?flagged:flat
        const safe   =Math.min(stepIdx,Math.max(0,stepSrc.length-1))
        const cur    =stepSrc[safe]
        return(
          <div className="screen rev-screen">
            <header className="rev-head">
              <div>
                <h1 className="rev-title">Review Script</h1>
                <p className="rev-sub">&#8220;{script.title}&#8221; &middot; {script.scenes.length} scenes &middot; {flat.length} lines &middot; {script.characters.length} characters</p>
              </div>
              <div className="rev-head-right">
                {flagged.length>0
                  ?<span className={`badge${pct>50?" red":" amber"}`}>⚑ {flagged.length} line{flagged.length!==1?"s":""} to review</span>
                  :<span className="badge green">✓ Looks clean</span>}
                <button className="go-btn sm" onClick={()=>setScreen("setup")}>Continue to Setup →</button>
              </div>
            </header>

            {pct>50&&<div className="warn-bar">
              <span><strong>⚠ {pct}% of lines need attention.</strong> For best results, try uploading a digital (not scanned) PDF.</span>
              <button className="reup-btn" onClick={()=>{setScript(null);setScreen("upload")}}>↑ New upload</button>
            </div>}

            <div className="rev-toolbar">
              <div className="tab-group">
                <button className={`tab${reviewMode==="scroll"?" on":""}`} onClick={()=>setReviewMode("scroll")}>📜 Scroll &amp; edit all</button>
                <button className={`tab${reviewMode==="step"?" on":""}`} onClick={()=>{setReviewMode("step");setStepIdx(0)}}>⟶ Step through</button>
              </div>
              {reviewMode==="step"&&<div className="tab-group sm">
                <button className={`tab${reviewFilter==="flagged"?" on":""}`} onClick={()=>{setReviewFilter("flagged");setStepIdx(0)}}>Flagged ({flagged.length})</button>
                <button className={`tab${reviewFilter==="all"?" on":""}`} onClick={()=>{setReviewFilter("all");setStepIdx(0)}}>All ({flat.length})</button>
              </div>}
            </div>

            {reviewMode==="scroll"&&(
              <div className="rev-body">
                {script.scenes.map((sc,si)=>(
                  <div key={si} className="rev-scene-block">
                    <h2 className="scene-label">{sc.title}</h2>
                    {sc.lines.map((line,li)=>{
                      const isEd=editLine?.si===si&&editLine?.li===li
                      return(
                        <div key={li} className={`rline${line.flagged?" flag":""}${isEd?" ed":""}`}
                          draggable={!isEd}
                          onDragStart={()=>{dragRef.current={si,li}}}
                          onDragOver={e=>{e.preventDefault();e.currentTarget.classList.add("drag-over")}}
                          onDragLeave={e=>{e.currentTarget.classList.remove("drag-over")}}
                          onDrop={e=>{
                            e.currentTarget.classList.remove("drag-over")
                            if(dragRef.current&&dragRef.current.si===si&&dragRef.current.li!==li){
                              moveLine(si,dragRef.current.li,li)
                            }
                            dragRef.current=null
                          }}
                          onDragEnd={e=>{e.currentTarget.classList.remove("drag-over");dragRef.current=null}}
                        >
                          {!isEd?(
                            <div className="rline-view">
                              <span className="drag-grip" title="Drag to reorder">⠿</span>
                              <div className="rline-main">
                                {line.character&&<span className="rline-char">{line.character}</span>}
                                <span className={`rline-text${line.isStageDirection?" dir":""}${!line.text?" empty":""}`}>
                                  {line.text||(line.flagged?"(empty — click ✏ to add)":"(empty)")}
                                </span>
                                {line.flagged&&<span className="flag-pip">⚑</span>}
                              </div>
                              <div className="rline-btns">
                                <button className="ract" onClick={()=>{setEditLine({si,li});setEditText(line.text);setEditChar(line.character||"")}}>✏</button>
                                <button className="ract" onClick={()=>voiceCorrect(si,li)} disabled={isVoiceCorr}>🎙</button>
                                <button className="ract danger" onClick={()=>delLine(si,li)}>✕</button>
                              </div>
                            </div>
                          ):(
                            <div className="rline-form">
                              <input className="form-char" placeholder="CHARACTER NAME (leave blank for stage direction)" value={editChar} onChange={e=>setEditChar(e.target.value)}/>
                              <textarea className="form-text" rows={3} value={editText} onChange={e=>setEditText(e.target.value)}/>
                              <div className="form-acts">
                                <button className="voice-btn" onClick={()=>voiceCorrect(si,li)} disabled={isVoiceCorr}>{isVoiceCorr?"🎙 Listening…":"🎙 Speak"}</button>
                                <button className="go-btn sm" onClick={()=>{updateLine(si,li,{text:editText,character:editChar||null,isStageDirection:!editChar,flagged:false});setEditLine(null)}}>Save</button>
                                <button className="cancel-btn" onClick={()=>setEditLine(null)}>Cancel</button>
                              </div>
                            </div>
                          )}
                          <button className="between-btn" onClick={()=>addLine(si,li)} title="Insert line below">+</button>
                        </div>
                      )
                    })}
                    <button className="end-btn" onClick={()=>addLine(si,sc.lines.length-1)}>+ Add line</button>
                  </div>
                ))}
              </div>
            )}

            {reviewMode==="step"&&stepSrc.length===0&&(
              <div className="rev-empty"><p>✓ No flagged lines!</p><button className="go-btn" onClick={()=>setScreen("setup")}>Continue →</button></div>
            )}

            {reviewMode==="step"&&cur&&(
              <div className="step-body">
                <div className="step-nav">
                  <button className="snav" disabled={safe===0} onClick={()=>setStepIdx(i=>Math.max(0,i-1))}>← Prev</button>
                  <span className="sctr">{safe+1} / {stepSrc.length}</span>
                  <button className="snav" disabled={safe>=stepSrc.length-1} onClick={()=>setStepIdx(i=>Math.min(stepSrc.length-1,i+1))}>Next →</button>
                </div>
                <div className="step-card">
                  <div className="step-scene-tag">{cur.scTitle}</div>
                  {cur.flagged&&<div className="step-flag">⚑ Needs review</div>}
                  <div className="step-field"><label className="step-lbl">Character</label>
                    <input className="step-in" value={cur.character||""} placeholder={cur.isStageDirection?"Stage direction":"CHARACTER NAME"} onChange={e=>updateLine(cur.si,cur.li,{character:e.target.value||null})}/>
                  </div>
                  <div className="step-field"><label className="step-lbl">Line text</label>
                    <textarea className="step-ta" rows={5} value={cur.text} onChange={e=>updateLine(cur.si,cur.li,{text:e.target.value,flagged:false})}/>
                  </div>
                  <div className="step-acts">
                    <button className="voice-btn" onClick={()=>voiceCorrect(cur.si,cur.li)} disabled={isVoiceCorr}>{isVoiceCorr?"🎙 Listening…":"🎙 Speak correction"}</button>
                    <button className="step-ok" onClick={()=>{updateLine(cur.si,cur.li,{flagged:false});setStepIdx(i=>Math.min(i+1,stepSrc.length-1))}}>✓ Mark OK &amp; Next</button>
                    <button className="step-del" onClick={()=>{delLine(cur.si,cur.li);setStepIdx(i=>Math.max(0,i-1))}}>🗑 Delete</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* ══ SETUP ═══════════════════════════════════════════════════════════ */}
      {screen==="setup"&&script&&(
        <div className="screen setup-screen">
          <header className="setup-head">
            <button className="back-btn" onClick={()=>setScreen("review")}>← Back to Review</button>
            <h1 className="play-title">&#8220;{script.title}&#8221;</h1>
            <p className="play-meta">{script.characters.length} characters &middot; {script.scenes.length} scenes</p>
          </header>

          <div className="setup-grid">
            {/* Cast panel */}
            <section className="panel">
              <p className="panel-label">YOUR ROLES</p>
              <p className="panel-hint">Select every character you are playing. You can play multiple roles — tick as many as you like.</p>

              {myChars.length>0&&(
                <div className="my-roles-box">
                  <p className="my-roles-label">You are playing:</p>
                  <div className="my-roles-chips">
                    {myChars.map(c=>(
                      <span key={c} className="role-chip">
                        {c}
                        <button onClick={()=>toggleMyRole(c)} title="Remove">✕</button>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="char-list">
                {script.characters.map(ch=>{
                  const isMine=myRoles.has(ch.name)
                  return(
                    <div key={ch.name} className={`char-card${isMine?" mine":""}`}>
                      <div className="char-top">
                        <span className="char-name">{ch.name}</span>
                        <button className={`role-btn${isMine?" on":""}`} onClick={()=>toggleMyRole(ch.name)}>
                          {isMine?"★ My role":"☆ I play this"}
                        </button>
                      </div>
                      {!isMine&&(
                        <div className="voice-area">
                          <div className="vtype-row">
                            {["female","male","other"].map(t=>(
                              <button key={t} className={`vt-btn${ch.voiceType===t?" on":""}`}
                                onClick={()=>setScript(s=>({...s,characters:s.characters.map(c=>c.name===ch.name?{...c,voiceType:t}:c)}))}>
                                {t==="female"?"♀":t==="male"?"♂":"⊙"} {t}
                              </button>
                            ))}
                          </div>
                          <div className="rec-row">
                            {recordings[ch.name]&&<span className="rec-ok">🎙 Custom voice</span>}
                            {recFor===ch.name&&isRec
                              ?<button className="rec-btn stop" onClick={stopRec}>⏹ Stop</button>
                              :<button className="rec-btn" onClick={()=>startRec(ch.name)}>🎙 Record</button>}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>

            {/* Scene panel */}
            <section className="panel">
              <p className="panel-label">CHOOSE A SCENE</p>
              {myChars.length>0&&(
                <label className="skip-toggle">
                  <input type="checkbox" checked={skipNoChar} onChange={e=>setSkipNoChar(e.target.checked)}/>
                  {" "}Only show scenes where I have lines
                </label>
              )}
              <label className="skip-toggle">
                <input type="checkbox" checked={hideStageDir} onChange={e=>setHideStageDir(e.target.checked)}/>
                {" "}Hide stage directions during rehearsal
              </label>

              <div className="scene-list">
                {script.scenes
                  .filter(sc=>!skipNoChar||myChars.length===0||sc.lines.some(l=>!l.isStageDirection&&myRoles.has(l.character)))
                  .map(sc=>{
                    const myCount=sc.lines.filter(l=>!l.isStageDirection&&myRoles.has(l.character)).length
                    const total=sc.lines.filter(l=>!l.isStageDirection).length
                    return(
                      <button key={sc.title} className={`scene-btn${selScene===sc.title?" on":""}`} onClick={()=>setSelScene(sc.title)}>
                        <span className="scene-name">{sc.title}</span>
                        <span className="scene-meta">
                          {total} lines{myCount>0&&<span className="my-ct"> · {myCount} yours</span>}
                        </span>
                      </button>
                    )
                  })}
              </div>

              {history.length>0&&(
                <div className="hist-box">
                  <p className="panel-label" style={{marginBottom:".5rem"}}>RECENT SCORES</p>
                  {history.slice(-6).reverse().map((r,i)=>(
                    <div key={i} className="hist-row">
                      <span>{MEDALS[r.medal].emoji}</span>
                      <span className="hist-scene">{r.scene}</span>
                      <span style={{color:MEDALS[r.medal].color,fontWeight:600}}>{r.accuracy}%</span>
                    </div>
                  ))}
                </div>
              )}

              <button className="go-btn full" disabled={!selScene||myChars.length===0} onClick={startRehearsal}>
                {!selScene?"← Select a scene first":myChars.length===0?"← Select your role(s)":"▶  Begin Rehearsal"}
              </button>
              <p className="setup-tip">💡 During rehearsal: click any word for a definition, right-click for modern English translation</p>
            </section>
          </div>
        </div>
      )}

      {/* ══ REHEARSAL ═══════════════════════════════════════════════════════ */}
      {screen==="rehearsal"&&script&&(
        <div className="screen reh-screen">
          <div className="reh-bar">
            <button className="exit-btn" onClick={stopRehearsal}>← Exit</button>
            <span className="reh-scene">{selScene}</span>
            <span className="reh-pos">{Math.min(curIdx+1,allLines.length)} / {allLines.length}</span>
          </div>

          <div className="script-pane">
            {allLines.map((line,i)=>{
              const isCur=i===curIdx,isPast=i<curIdx
              const isMe=!line.isStageDirection&&myRoles.has(line.character)
              const result=lineResults.find(r=>r.lineIdx===i)
              return(
                <div key={i} className={["sl",isCur?"cur":"",isPast?"past":"",line.isStageDirection?"dir":"",isMe?"mine":""].filter(Boolean).join(" ")}>
                  {!line.isStageDirection&&<span className="sl-char">{line.character}</span>}
                  <span className="sl-text">
                    {isCur&&isMe&&phase==="showing"&&result
                      ?diffTokens(line.text,result.spoken).map((tok,j)=>tok.sp?<span key={j}> </span>:<span key={j} className={`sw ${tok.ok?"ok":"bad"}`} onClick={()=>lookupWord(tok.text,line.text,"def")} onContextMenu={e=>{e.preventDefault();lookupWord(tok.text,line.text,"mod")}}>{tok.text}</span>)
                      :line.text.split(/(\s+)/).map((tok,j)=>/^\s+$/.test(tok)?<span key={j}> </span>:<span key={j} className="sw click" onClick={()=>lookupWord(tok,line.text,"def")} onContextMenu={e=>{e.preventDefault();lookupWord(tok,line.text,"mod")}}>{tok}</span>)
                    }
                  </span>
                  {result&&<span className={`sl-pct ${result.accuracy===100?"gold":result.accuracy>=75?"ok":"low"}`}>{result.accuracy}%</span>}
                </div>
              )
            })}
          </div>

          <div className="dock">
            {phase==="speaking"&&curLine&&!curLine.isStageDirection&&(
              <div className="dock-row">
                <div className="waves">{[10,20,30,20,10].map((h,i)=><span key={i} style={{height:h,animationDelay:`${i*.1}s`}}/>)}</div>
                <div><span className="dock-who">{curLine.character}</span><span className="dock-muted"> is speaking…</span></div>
              </div>
            )}
            {phase==="stage"&&curLine&&<div className="dock-row"><span>🎬</span><em className="dock-muted">{curLine.text}</em></div>}
            {phase==="myLine"&&(
              <div className="dock-col">
                <div className="your-turn">YOUR LINE — {curLine?.character}</div>
                <p className="dock-muted">Get ready…</p>
                {promptHint&&<div className="prompt-hint">💡 {promptHint}</div>}
              </div>
            )}
            {phase==="listening"&&(
              <div className="dock-row listen-row">
                <div className="mic-pulse"/>
                <div className="dock-col left">
                  <span className="listen-lbl">Listening…</span>
                  {curSpoken&&<span className="interim">&#8220;{curSpoken}&#8221;</span>}
                  {promptHint&&<div className="prompt-hint">💡 {promptHint}</div>}
                </div>
                <button className="hint-btn" onClick={requestPrompt}>💡 Prompt me</button>
              </div>
            )}
            {phase==="showing"&&curAccuracy!==null&&(
              <div className="dock-row">
                <div className={`acc-ring ${curAccuracy===100?"gold":curAccuracy>=75?"ok":"low"}`}><span className="acc-num">{curAccuracy}%</span></div>
                <div className="dock-col left">
                  {curAccuracy===100?<p className="bravo">✨ Word perfect!</p>:<><p className="you-said-lbl">You said:</p><p className="you-said">&#8220;{curSpoken||"(nothing recognised)"}&#8221;</p></>}
                </div>
              </div>
            )}
            {phase==="complete"&&(()=>{
              const{medal,accuracy,prompts}=scoreMedal(lineResults);const M=MEDALS[medal]
              return(
                <div className="dock-row complete-row">
                  <span className="medal-em">{M.emoji}</span>
                  <div className="dock-col left">
                    <div className="medal-lbl" style={{color:M.color}}>{M.label}</div>
                    <div className="dock-muted">Accuracy: {accuracy}% · Prompts: {prompts}</div>
                    {medal==="gold"&&<div className="gold-msg">🌟 Perfect score — no prompts needed!</div>}
                  </div>
                  <div className="complete-btns">
                    <button className="go-btn sm" onClick={startRehearsal}>🔁 Again</button>
                    <button className="exit-btn" onClick={stopRehearsal}>← Setup</button>
                  </div>
                </div>
              )
            })()}
            {(phase==="listening"||phase==="myLine")&&<p className="dock-tip">Click any word for definition · Right-click for modern English</p>}
          </div>
        </div>
      )}

      {/* ══ WORD MODAL ══════════════════════════════════════════════════════ */}
      {wModal&&(
        <div className="overlay" onClick={()=>{setWModal(null);setWResult("")}}>
          <div className="wmodal" onClick={e=>e.stopPropagation()}>
            <div className="wtabs">
              <button className={`wtab${wModal.mode==="def"?" on":""}`} onClick={()=>{setWResult("");lookupWord(wModal.word,wModal.lineText,"def");setWModal(m=>({...m,mode:"def"}))}}>📖 Definition</button>
              <button className={`wtab${wModal.mode==="mod"?" on":""}`} onClick={()=>{setWResult("");lookupWord(wModal.word,wModal.lineText,"mod");setWModal(m=>({...m,mode:"mod"}))}}>💬 Modern English</button>
            </div>
            <h3 className="wmod-word">&#8220;{wModal.word}&#8221;</h3>
            {wLoad?<p className="wmod-loading">Consulting the prompt book…</p>:<p className="wmod-result">{wResult}</p>}
            <button className="wmod-close" onClick={()=>{setWModal(null);setWResult("")}}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}

const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Lora:ital,wght@0,500;1,400&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
.app{font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:#F4F3F0;color:#1C1917;min-height:100vh}
.screen{min-height:100vh}
.center-screen{display:flex;align-items:center;justify-content:center;padding:2rem}
.go-btn{background:#1C1917;color:#fff;border:none;border-radius:10px;padding:.75rem 1.75rem;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:.92rem;font-weight:600;transition:background .18s,transform .15s}
.go-btn:hover:not(:disabled){background:#333;transform:translateY(-1px)}
.go-btn:disabled{background:#D6D3CF;color:#A8A29E;cursor:not-allowed}
.go-btn.sm{padding:.48rem 1.05rem;font-size:.82rem}
.go-btn.full{width:100%;margin-top:.5rem}
.upload-box{text-align:center;width:100%;max-width:480px}
.key-card{background:#fff;border:1px solid #E7E5E4;border-radius:14px;padding:1.75rem;text-align:left;margin-top:.5rem}
.key-title{font-size:1rem;font-weight:700;color:#1C1917;margin-bottom:.4rem}
.key-body{font-size:.83rem;color:#78716C;line-height:1.6;margin-bottom:.9rem}
.key-steps{font-size:.82rem;color:#44403C;line-height:1.85;padding-left:1.2rem;margin-bottom:1rem}
.key-steps a{color:#6366F1;text-underline-offset:2px}
.key-steps code{background:#F4F3F0;padding:.1rem .35rem;border-radius:4px;font-size:.8rem}
.key-row{display:flex;gap:.5rem;margin-bottom:.65rem}
.key-input{flex:1;background:#F4F3F0;border:1px solid #E7E5E4;border-radius:9px;padding:.6rem .85rem;font-family:'Plus Jakarta Sans',sans-serif;font-size:.88rem;color:#1C1917;outline:none;transition:border-color .18s}
.key-input:focus{border-color:#1C1917;background:#fff}
.key-note{font-size:.74rem;color:#A8A29E;line-height:1.5}
.change-key-btn{background:transparent;border:none;color:#A8A29E;font-family:'Plus Jakarta Sans',sans-serif;font-size:.75rem;cursor:pointer;margin-top:.6rem;text-decoration:underline;text-decoration-style:dotted;transition:color .15s}
.change-key-btn:hover{color:#44403C}
.brand{margin-bottom:2.5rem}
.brand-icon{font-size:2.6rem;display:block;margin-bottom:.7rem}
.brand-name{font-size:2.3rem;font-weight:700;letter-spacing:-.02em;margin-bottom:.3rem}
.brand-sub{font-size:.92rem;color:#78716C}
.dz-wrap{display:flex;flex-direction:column;align-items:center;gap:.9rem;width:100%}
.dz{border:1.5px dashed #D6D3CF;border-radius:14px;padding:2.5rem 2rem;cursor:pointer;text-align:center;background:#fff;width:100%;transition:border-color .2s,background .2s}
.dz:hover,.dz.drag{border-color:#1C1917;background:#FAFAF8}
.dz.filled{border-style:solid;border-color:#78716C}
.dz-ico{font-size:1.8rem;margin-bottom:.5rem}
.dz-txt{font-size:.98rem;font-weight:600;margin-bottom:.2rem}
.dz-sub{font-size:.82rem;color:#A8A29E}
.dz-list{list-style:none;margin-top:.5rem;font-size:.8rem;color:#78716C}
.proc-card{background:#fff;border:1px solid #E7E5E4;border-radius:16px;padding:2.5rem 2rem;max-width:440px;width:100%;text-align:center}
.spinner{font-size:2.2rem;display:inline-block;animation:spin 2.5s linear infinite;margin-bottom:1rem}
@keyframes spin{to{transform:rotate(360deg)}}
.proc-title{font-size:1.2rem;font-weight:700;margin-bottom:.4rem}
.proc-step{font-size:.87rem;color:#78716C;min-height:1.4em;margin-bottom:1.2rem;line-height:1.5}
.prog-track{background:#F4F3F0;border-radius:999px;height:8px;overflow:hidden;margin-bottom:.35rem;position:relative}
.prog-fill{height:100%;background:#1C1917;border-radius:999px;transition:width .6s ease}
.prog-pulse{position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,.35) 50%,transparent 100%);animation:shimmer 1.6s ease-in-out infinite;background-size:200% 100%}
@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.prog-foot{display:flex;justify-content:space-between;align-items:center;min-height:1.2rem}
.prog-pct{font-size:.78rem;color:#A8A29E;font-weight:500}
.elapsed{font-size:.75rem;color:#78716C;font-style:italic;animation:fadein .5s ease}
@keyframes fadein{from{opacity:0}to{opacity:1}}
.proc-notice{margin-top:1.2rem;padding:.9rem 1.1rem;background:#FEF9EE;border:1px solid #F0E6C0;border-radius:10px;display:flex;flex-direction:column;gap:.3rem}
.proc-err{margin-top:1.2rem;padding:.9rem 1rem;background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;font-size:.85rem;color:#991B1B;line-height:1.6}
.badge{padding:.28rem .75rem;border-radius:999px;font-size:.75rem;font-weight:600}
.badge.amber{background:#FEF3C7;color:#92400E}
.badge.red{background:#FEE2E2;color:#991B1B}
.badge.green{background:#D1FAE5;color:#065F46}
.rev-screen{background:#F4F3F0;display:flex;flex-direction:column}
.rev-head{display:flex;justify-content:space-between;align-items:center;background:#fff;padding:1.1rem 1.75rem;border-bottom:1px solid #E7E5E4;flex-shrink:0;gap:1rem;flex-wrap:wrap}
.rev-title{font-size:1.15rem;font-weight:700}
.rev-sub{font-size:.82rem;color:#78716C;margin-top:.1rem}
.rev-head-right{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
.warn-bar{background:#FEF2F2;border-bottom:1px solid #FECACA;padding:.7rem 1.75rem;display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;font-size:.83rem;color:#7F1D1D;flex-shrink:0}
.reup-btn{background:#fff;border:1px solid #FECACA;color:#DC2626;padding:.28rem .75rem;border-radius:7px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:.78rem;font-weight:600;white-space:nowrap}
.reup-btn:hover{background:#FEE2E2}
.rev-toolbar{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;background:#fff;border-bottom:1px solid #E7E5E4;padding:.6rem 1.75rem;flex-shrink:0}
.tab-group{display:flex;gap:.3rem}
.tab{background:#F4F3F0;border:1px solid #E7E5E4;color:#78716C;padding:.3rem .82rem;border-radius:7px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:.8rem;font-weight:600;transition:all .18s}
.tab.on{background:#1C1917;border-color:#1C1917;color:#fff}
.tab-group.sm .tab.on{background:#78716C;border-color:#78716C}
.rev-body{flex:1;overflow-y:auto;padding:1.5rem 1.75rem;display:flex;flex-direction:column;gap:1.5rem;max-width:820px;width:100%;margin:0 auto}
.rev-scene-block{}
.scene-label{font-size:.68rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#A8A29E;margin-bottom:.6rem;padding-bottom:.45rem;border-bottom:1px solid #E7E5E4}
.rline{position:relative;border-radius:9px;border:1px solid transparent;transition:border-color .15s;margin-bottom:1px}
.rline:hover{border-color:#E7E5E4}
.rline.flag{background:#FFFBEB;border-color:#FCD34D}
.rline.ed{background:#fff;border-color:#1C1917;box-shadow:0 0 0 3px rgba(28,25,23,.06)}
.rline-view{display:flex;align-items:flex-start;gap:.5rem;padding:.52rem .7rem;padding-right:0}
.rline-main{display:flex;gap:.7rem;align-items:baseline;flex:1;flex-wrap:wrap}
.rline-char{font-size:.68rem;font-weight:700;letter-spacing:.07em;color:#6366F1;min-width:90px;flex-shrink:0}
.rline-text{font-size:.89rem;color:#44403C;line-height:1.55;flex:1}
.rline-text.dir{font-style:italic;color:#A8A29E}
.rline-text.empty{color:#D6D3CF;font-style:italic}
.flag-pip{font-size:.72rem;color:#D97706;flex-shrink:0}
.rline-btns{display:flex;gap:2px;flex-shrink:0;opacity:0;transition:opacity .15s;padding:.28rem}
.rline:hover .rline-btns,.rline.flag .rline-btns{opacity:1}
.ract{background:transparent;border:1px solid transparent;color:#A8A29E;width:26px;height:26px;border-radius:6px;cursor:pointer;font-size:.78rem;display:flex;align-items:center;justify-content:center;transition:all .15s}
.ract:hover{background:#F4F3F0;border-color:#E7E5E4;color:#1C1917}
.ract.danger:hover{background:#FEE2E2;border-color:#FECACA;color:#DC2626}
.ract:disabled{opacity:.35;cursor:not-allowed}
.rline-form{padding:.7rem;display:flex;flex-direction:column;gap:.45rem}
.form-char{background:#F4F3F0;border:1px solid #E7E5E4;border-radius:7px;padding:.38rem .7rem;font-family:'Plus Jakarta Sans',sans-serif;font-size:.75rem;font-weight:700;letter-spacing:.06em;color:#6366F1;width:100%;outline:none}
.form-char:focus{border-color:#6366F1;background:#fff}
.form-text{background:#F4F3F0;border:1px solid #E7E5E4;border-radius:7px;padding:.52rem .7rem;font-family:'Plus Jakarta Sans',sans-serif;font-size:.89rem;color:#1C1917;width:100%;resize:vertical;outline:none;line-height:1.55}
.form-text:focus{border-color:#1C1917;background:#fff}
.form-acts{display:flex;gap:.45rem;align-items:center;flex-wrap:wrap}
.voice-btn{background:#F4F3F0;border:1px solid #E7E5E4;color:#44403C;padding:.34rem .78rem;border-radius:7px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:.8rem;font-weight:600;transition:all .18s}
.voice-btn:hover:not(:disabled){border-color:#1C1917}
.voice-btn:disabled{opacity:.5;cursor:not-allowed}
.cancel-btn{background:transparent;border:none;color:#A8A29E;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:.82rem;padding:.34rem .45rem;transition:color .15s}
.cancel-btn:hover{color:#1C1917}
.between-btn{display:block;width:100%;background:transparent;border:none;color:transparent;font-size:.7rem;cursor:pointer;padding:2px 0;text-align:center;transition:all .15s;line-height:1}
.rline:hover~.between-btn,.between-btn:hover{color:#D6D3CF}
.between-btn:hover{color:#A8A29E}
.drag-grip{color:#D6D3CF;font-size:.9rem;cursor:grab;padding:.52rem .5rem;flex-shrink:0;user-select:none;transition:color .15s}
.rline:hover .drag-grip{color:#A8A29E}
.drag-grip:active{cursor:grabbing}
.rline.drag-over{border-color:#6366F1 !important;background:#F5F5FF !important;box-shadow:0 0 0 2px rgba(99,102,241,.25)}
.end-btn{background:transparent;border:1px dashed #D6D3CF;color:#A8A29E;border-radius:8px;padding:.42rem;cursor:pointer;width:100%;font-family:'Plus Jakarta Sans',sans-serif;font-size:.78rem;font-weight:600;margin-top:.4rem;transition:all .18s}
.end-btn:hover{border-color:#A8A29E;color:#44403C;background:#fff}
.rev-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.2rem;padding:3rem;font-size:.98rem;color:#78716C}
.step-body{flex:1;display:flex;flex-direction:column;align-items:center;padding:2rem 1.5rem;gap:1.2rem;overflow-y:auto}
.step-nav{display:flex;align-items:center;gap:.9rem}
.snav{background:#fff;border:1px solid #E7E5E4;color:#44403C;padding:.4rem .95rem;border-radius:8px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:.82rem;font-weight:600;transition:all .18s}
.snav:hover:not(:disabled){border-color:#1C1917;color:#1C1917}
.snav:disabled{opacity:.35;cursor:not-allowed}
.sctr{font-size:.82rem;font-weight:600;color:#78716C;min-width:54px;text-align:center}
.step-card{background:#fff;border:1px solid #E7E5E4;border-radius:14px;padding:1.65rem;width:100%;max-width:640px;display:flex;flex-direction:column;gap:.85rem}
.step-scene-tag{font-size:.67rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#A8A29E}
.step-flag{display:inline-flex;align-items:center;background:#FEF3C7;color:#92400E;padding:.24rem .58rem;border-radius:6px;font-size:.74rem;font-weight:600;width:fit-content}
.step-field{display:flex;flex-direction:column;gap:.28rem}
.step-lbl{font-size:.67rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#A8A29E}
.step-in{background:#F4F3F0;border:1px solid #E7E5E4;border-radius:8px;padding:.48rem .78rem;font-family:'Plus Jakarta Sans',sans-serif;font-size:.82rem;font-weight:700;letter-spacing:.05em;color:#6366F1;outline:none}
.step-in:focus{border-color:#6366F1;background:#fff}
.step-ta{background:#F4F3F0;border:1px solid #E7E5E4;border-radius:8px;padding:.62rem .78rem;font-family:'Plus Jakarta Sans',sans-serif;font-size:.92rem;color:#1C1917;resize:vertical;outline:none;line-height:1.6}
.step-ta:focus{border-color:#1C1917;background:#fff}
.step-acts{display:flex;gap:.52rem;align-items:center;flex-wrap:wrap}
.step-ok{background:#1C1917;color:#fff;border:none;border-radius:8px;padding:.46rem 1rem;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:.82rem;font-weight:600;transition:background .18s}
.step-ok:hover{background:#333}
.step-del{background:transparent;border:1px solid #FECACA;color:#DC2626;padding:.46rem .82rem;border-radius:8px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:.78rem;font-weight:600;margin-left:auto;transition:all .18s}
.step-del:hover{background:#FEE2E2}
.setup-screen{background:#F4F3F0;min-height:100vh;padding-bottom:3rem}
.setup-head{background:#fff;padding:1.2rem 2rem;border-bottom:1px solid #E7E5E4;text-align:center}
.back-btn{background:transparent;border:none;color:#6366F1;font-family:'Plus Jakarta Sans',sans-serif;font-size:.8rem;font-weight:600;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;margin-bottom:.5rem;display:block;transition:color .15s}
.back-btn:hover{color:#4F46E5}
.play-title{font-family:'Lora',serif;font-size:1.6rem;font-weight:500;font-style:italic}
.play-meta{font-size:.76rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#A8A29E;margin-top:.3rem}
.setup-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.4rem;max-width:980px;margin:1.5rem auto;padding:0 1.5rem}
@media(max-width:640px){.setup-grid{grid-template-columns:1fr}}
.panel{background:#fff;border:1px solid #E7E5E4;border-radius:14px;padding:1.35rem}
.panel-label{font-size:.67rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#A8A29E;margin-bottom:.28rem}
.panel-hint{font-size:.82rem;color:#A8A29E;margin-bottom:.85rem;line-height:1.5}
.my-roles-box{background:#EEF2FF;border:1px solid #C7D2FE;border-radius:9px;padding:.65rem .85rem;margin-bottom:.85rem}
.my-roles-label{font-size:.67rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#6366F1;margin-bottom:.4rem}
.my-roles-chips{display:flex;flex-wrap:wrap;gap:.38rem}
.role-chip{background:#fff;border:1px solid #C7D2FE;color:#4338CA;border-radius:999px;padding:.2rem .62rem;font-size:.78rem;font-weight:600;display:flex;align-items:center;gap:.32rem}
.role-chip button{background:transparent;border:none;color:#9CA3AF;cursor:pointer;font-size:.72rem;line-height:1;padding:0;transition:color .15s}
.role-chip button:hover{color:#DC2626}
.char-list{display:flex;flex-direction:column;gap:.42rem;max-height:400px;overflow-y:auto;padding-right:2px}
.char-card{background:#FAFAF8;border:1px solid #E7E5E4;border-radius:9px;padding:.75rem .9rem;transition:border-color .18s}
.char-card.mine{border-color:#6366F1;background:#F5F5FF}
.char-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:.32rem}
.char-name{font-size:.82rem;font-weight:700;letter-spacing:.03em}
.role-btn{background:transparent;border:1px solid #D6D3CF;color:#78716C;padding:.2rem .68rem;border-radius:999px;font-size:.75rem;font-weight:500;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;transition:all .18s}
.role-btn.on{background:#6366F1;border-color:#6366F1;color:#fff}
.role-btn:hover:not(.on){border-color:#78716C;color:#1C1917}
.voice-area{padding-top:.35rem;border-top:1px solid #F0EEE9;margin-top:.35rem}
.vtype-row{display:flex;gap:.32rem;margin-bottom:.42rem}
.vt-btn{background:#F4F3F0;border:1px solid #E7E5E4;color:#78716C;padding:.18rem .6rem;border-radius:6px;font-size:.75rem;font-weight:500;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;transition:all .18s}
.vt-btn.on{background:#1C1917;border-color:#1C1917;color:#fff}
.rec-row{display:flex;gap:.42rem;align-items:center;flex-wrap:wrap}
.rec-btn{background:transparent;border:1px solid #E7E5E4;color:#78716C;padding:.18rem .62rem;border-radius:6px;font-size:.74rem;font-weight:500;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;transition:all .18s}
.rec-btn:hover{border-color:#78716C;color:#1C1917}
.rec-btn.stop{border-color:#DC2626;color:#DC2626;animation:blink 1s step-end infinite}
@keyframes blink{50%{opacity:.4}}
.rec-ok{font-size:.74rem;color:#16A34A;font-weight:500}
.skip-toggle{display:flex;align-items:center;gap:.42rem;font-size:.8rem;color:#78716C;cursor:pointer;font-weight:500;margin-bottom:.72rem}
.skip-toggle input{accent-color:#1C1917;cursor:pointer}
.scene-list{display:flex;flex-direction:column;gap:.32rem;max-height:250px;overflow-y:auto;margin-bottom:.9rem}
.scene-btn{background:#FAFAF8;border:1px solid #E7E5E4;color:#44403C;padding:.62rem .88rem;border-radius:9px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:.85rem;font-weight:500;display:flex;justify-content:space-between;align-items:center;transition:all .18s;text-align:left;width:100%}
.scene-btn:hover{border-color:#A8A29E;color:#1C1917}
.scene-btn.on{background:#1C1917;border-color:#1C1917;color:#fff}
.scene-name{flex:1;text-align:left}
.scene-meta{font-size:.74rem;opacity:.65;white-space:nowrap;margin-left:.5rem}
.my-ct{color:#A5B4FC}
.scene-btn.on .my-ct{color:#C7D2FE}
.hist-box{margin:.85rem 0 .95rem;padding-top:.85rem;border-top:1px solid #F0EEE9}
.hist-row{display:flex;gap:.62rem;align-items:center;padding:.26rem 0;font-size:.82rem;border-bottom:1px solid #F4F3F0}
.hist-scene{flex:1;color:#78716C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:.78rem}
.setup-tip{font-size:.74rem;color:#A8A29E;margin-top:.72rem;line-height:1.5}
.reh-screen{display:flex;flex-direction:column;height:100vh;background:#111827;color:#F9FAFB}
.reh-bar{display:flex;justify-content:space-between;align-items:center;padding:.68rem 1.2rem;background:#1F2937;border-bottom:1px solid #374151;flex-shrink:0}
.exit-btn{background:transparent;border:1px solid #374151;color:#9CA3AF;padding:.3rem .8rem;border-radius:7px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:.8rem;font-weight:500;transition:all .18s}
.exit-btn:hover{border-color:#9CA3AF;color:#F9FAFB}
.reh-scene{font-family:'Lora',serif;color:#F9FAFB;font-style:italic;font-size:.9rem}
.reh-pos{color:#4B5563;font-size:.78rem;font-weight:500}
.script-pane{flex:1;overflow-y:auto;padding:1.2rem 1.65rem;display:flex;flex-direction:column;gap:.08rem}
.sl{display:flex;gap:.85rem;align-items:baseline;padding:.46rem .7rem;border-radius:8px;opacity:.24;transition:opacity .35s,background .35s}
.sl.past{opacity:.14}
.sl.cur{opacity:1;background:rgba(255,255,255,.04)}
.sl.cur.mine{background:rgba(99,102,241,.1)}
.sl.dir{font-style:italic;font-size:.84rem;color:#6B7280}
.sl-char{font-size:.67rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6366F1;min-width:94px;flex-shrink:0;padding-top:3px}
.sl-text{font-size:.97rem;line-height:1.7;flex:1;color:#E5E7EB}
.sl.cur .sl-text{color:#F9FAFB}
.sl-pct{font-size:.75rem;font-weight:600;margin-left:auto;flex-shrink:0}
.sl-pct.gold{color:#FBBF24}.sl-pct.ok{color:#34D399}.sl-pct.low{color:#F87171}
.sw.click{cursor:pointer}.sw.click:hover{color:#A5B4FC;text-decoration:underline;text-decoration-style:dotted}
.sw.ok{color:#34D399}.sw.bad{color:#F87171;text-decoration:line-through}
.dock{flex-shrink:0;min-height:116px;background:#1F2937;border-top:1px solid #374151;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1.1rem 2rem;gap:.48rem;text-align:center}
.dock-row{display:flex;align-items:center;gap:.95rem;width:100%;justify-content:center;flex-wrap:wrap}
.dock-col{display:flex;flex-direction:column;gap:.18rem}
.dock-col.left{text-align:left}
.dock-muted{color:#6B7280;font-size:.87rem}
.dock-who{font-weight:700;color:#A5B4FC;font-size:.9rem}
.waves{display:flex;align-items:center;gap:3px;height:24px}
.waves span{display:block;width:3px;border-radius:2px;background:#6366F1;animation:wave .85s ease-in-out infinite}
@keyframes wave{0%,100%{transform:scaleY(.2)}50%{transform:scaleY(1)}}
.your-turn{font-size:.68rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#A5B4FC;animation:breathe 1.6s ease-in-out infinite}
@keyframes breathe{0%,100%{opacity:.45}50%{opacity:1}}
.listen-row{align-items:flex-start}
.mic-pulse{width:38px;height:38px;border-radius:50%;flex-shrink:0;background:rgba(239,68,68,.14);border:2px solid #EF4444;animation:mpulse 1.1s ease-out infinite}
@keyframes mpulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,.4)}70%{box-shadow:0 0 0 14px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
.listen-lbl{color:#F9FAFB;font-size:.87rem;font-weight:600}
.interim{font-size:.82rem;color:#6B7280;font-style:italic}
.hint-btn{background:transparent;border:1px solid #374151;color:#9CA3AF;padding:.34rem .8rem;border-radius:7px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:.78rem;font-weight:500;flex-shrink:0;transition:all .18s}
.hint-btn:hover{border-color:#9CA3AF;color:#F9FAFB}
.prompt-hint{font-size:.82rem;color:#D1FAE5;background:rgba(52,211,153,.1);padding:.26rem .68rem;border-radius:6px;border:1px solid rgba(52,211,153,.2);display:inline-block;margin-top:.12rem}
.acc-ring{width:60px;height:60px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:2px solid transparent}
.acc-ring.gold{border-color:#FBBF24}.acc-ring.ok{border-color:#34D399}.acc-ring.low{border-color:#F87171}
.acc-num{font-size:1.18rem;font-weight:700}
.acc-ring.gold .acc-num{color:#FBBF24}.acc-ring.ok .acc-num{color:#34D399}.acc-ring.low .acc-num{color:#F87171}
.bravo{font-weight:600;color:#34D399;font-size:.93rem}
.you-said-lbl{font-size:.7rem;color:#6B7280;text-transform:uppercase;letter-spacing:.05em;font-weight:600;margin-bottom:.1rem}
.you-said{font-style:italic;color:#9CA3AF;font-size:.87rem}
.complete-row{flex-wrap:wrap;justify-content:center;gap:1rem}
.medal-em{font-size:2.7rem}
.medal-lbl{font-size:1.05rem;font-weight:700;margin-bottom:.15rem}
.gold-msg{font-size:.78rem;color:#FCD34D;margin-top:.22rem}
.complete-btns{display:flex;gap:.55rem;align-items:center}
.dock-tip{font-size:.7rem;color:#374151;margin-top:.12rem}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(5px)}
.wmodal{background:#fff;border-radius:16px;padding:1.65rem;max-width:415px;width:92%;box-shadow:0 20px 60px rgba(0,0,0,.18)}
.wtabs{display:flex;gap:.38rem;margin-bottom:1.05rem}
.wtab{background:#F4F3F0;border:1px solid #E7E5E4;color:#78716C;padding:.28rem .8rem;border-radius:7px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:.78rem;font-weight:600;transition:all .18s}
.wtab.on{background:#1C1917;border-color:#1C1917;color:#fff}
.wmod-word{font-family:'Lora',serif;font-size:1.42rem;color:#1C1917;font-style:italic;margin-bottom:.82rem}
.wmod-loading{color:#A8A29E;font-size:.87rem}
.wmod-result{color:#44403C;line-height:1.75;font-size:.9rem}
.wmod-close{margin-top:1.2rem;width:100%;background:#F4F3F0;border:1px solid #E7E5E4;color:#78716C;padding:.5rem;border-radius:9px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:.84rem;font-weight:600;transition:all .18s}
.wmod-close:hover{background:#E7E5E4;color:#1C1917}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#D6D3CF;border-radius:2px}
`
